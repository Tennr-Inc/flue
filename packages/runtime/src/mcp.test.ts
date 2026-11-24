import type { Client, Tool, Transport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { defineMcpConnection } from './hooks/use-mcp-connection.ts';
import {
	createMcpConnection,
	createMcpConnectionCache,
	createMcpConnectionWithClient,
	type McpConnectionDefinition,
	type McpToolDiscovery,
	readMcpSkippedTools,
} from './mcp.ts';
import { createFakeMcpServer } from './test-utils/fake-mcp-server.ts';
import { assertToolDefinition, defineTool } from './tool.ts';

/**
 * A stub MCP client: `createMcpConnectionWithClient` only needs listTools
 * (discovery), connect/close (lifecycle), and callTool (never reached in
 * these tests). Transport is never touched — the stub ignores it.
 */
function stubClient(tools: Tool[]): Pick<Client, 'callTool' | 'close' | 'connect' | 'listTools'> {
	return {
		connect: async () => {},
		close: async () => {},
		listTools: async () => ({ tools }),
		callTool: async () => ({ content: [] }),
	};
}

describe('MCP tool annotations', () => {
	it("carries the server's annotations through to the adapted tool definition", async () => {
		const connection = await createMcpConnectionWithClient(
			'test',
			stubClient([
				{
					name: 'create_issue',
					title: 'Create Issue',
					description: 'Creates a new issue.',
					inputSchema: { type: 'object', properties: {}, required: [] },
					annotations: {
						title: 'Create Issue',
						readOnlyHint: false,
						destructiveHint: true,
						idempotentHint: false,
						openWorldHint: false,
					},
				},
			]),
			{} as Transport,
		);

		expect(connection.tools).toHaveLength(1);
		const tool = connection.tools[0];
		if (!tool) throw new Error('Expected one adapted MCP tool.');
		expect(tool.name).toBe('mcp__test__create_issue');
		expect(tool.annotations).toEqual({
			title: 'Create Issue',
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});
		expect(Object.isFrozen(tool.annotations)).toBe(true);
		expect(Object.isFrozen(tool)).toBe(true);
		// The existing description path still reads the annotation title.
		expect(tool.description).toContain('Title: Create Issue.');
	});

	it('omits annotations when the server declares none', async () => {
		const connection = await createMcpConnectionWithClient(
			'test',
			stubClient([
				{
					name: 'search_issues',
					description: 'Searches issues.',
					inputSchema: { type: 'object', properties: {}, required: [] },
				},
			]),
			{} as Transport,
		);

		expect(connection.tools[0]?.annotations).toBeUndefined();
		expect(connection.tools[0]?.name).toBe('mcp__test__search_issues');
	});

	it('accepts annotations on hand-written tool definitions', () => {
		const tool = defineTool({
			name: 'wipe_data',
			description: 'Deletes everything.',
			annotations: { destructiveHint: true },
			run: () => ({ output: 'wiped' }),
		});
		expect(tool.annotations).toEqual({ destructiveHint: true });
		expect(Object.isFrozen(tool.annotations)).toBe(true);
		// The same validation path useTool() runs accepts the field.
		expect(() => assertToolDefinition(tool, 'test')).not.toThrow();
	});

	it('rejects malformed annotations in the definition validation', () => {
		expect(() =>
			assertToolDefinition(
				{
					name: 'wipe_data',
					description: 'Deletes everything.',
					annotations: { destructiveHint: 'yes' },
					run: () => undefined,
				},
				'test',
			),
		).toThrow(/annotations\.destructiveHint must be a boolean/);

		expect(() =>
			assertToolDefinition(
				{
					name: 'wipe_data',
					description: 'Deletes everything.',
					annotations: { readOnlyhint: true },
					run: () => undefined,
				},
				'test',
			),
		).toThrow(/annotations received unknown field "readOnlyhint"/);
	});
});

describe('MCP tool approval', () => {
	const createIssue: Tool = {
		name: 'create_issue',
		title: 'Create issue',
		description: 'Creates a new issue.',
		inputSchema: {
			type: 'object',
			properties: { title: { type: 'string' }, teamId: { type: 'string' } },
			required: ['title'],
		},
	};
	const searchIssues: Tool = {
		name: 'search_issues',
		description: 'Searches issues.',
		inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
	};

	async function connect(
		tools: Tool[],
		selection: Parameters<typeof createMcpConnectionWithClient>[4],
	) {
		return createMcpConnectionWithClient(
			'linear',
			stubClient(tools),
			{} as Transport,
			{},
			selection,
		);
	}

	it('gates every mounted tool when the policy names none', async () => {
		const connection = await connect([createIssue, searchIssues], {
			approval: { required: true, expiresInMs: 60_000 },
		});
		const [create, search] = connection.tools;
		expect(create?.approval).toEqual({
			required: true,
			expiresInMs: 60_000,
			presentation: { title: 'Create issue' },
		});
		expect(search?.approval).toEqual({ required: true, expiresInMs: 60_000 });
		expect(create?.version).toMatch(/^mcp:[0-9a-f]{32}$/);
		expect(search?.version).toMatch(/^mcp:[0-9a-f]{32}$/);
		expect(create?.version).not.toBe(search?.version);
		expect(Object.isFrozen(create?.approval)).toBe(true);
	});

	it('gates only the named tools', async () => {
		const connection = await connect([createIssue, searchIssues], {
			approval: { required: true, tools: ['create_issue'] },
		});
		const [create, search] = connection.tools;
		expect(create?.approval?.required).toBe(true);
		expect(search?.approval).toBeUndefined();
		expect(search?.version).toBeUndefined();
	});

	it('leaves tools ungated without a policy', async () => {
		const connection = await connect([createIssue], {});
		expect(connection.tools[0]?.approval).toBeUndefined();
		expect(connection.tools[0]?.version).toBeUndefined();
	});

	it('derives a version from the input schema, independent of key order', async () => {
		const [base] = (await connect([createIssue], { approval: { required: true } })).tools;
		const [reordered] = (
			await connect(
				[
					{
						...createIssue,
						inputSchema: {
							required: ['title'],
							properties: { teamId: { type: 'string' }, title: { type: 'string' } },
							type: 'object',
						},
					},
				],
				{ approval: { required: true } },
			)
		).tools;
		const [redescribed] = (
			await connect([{ ...createIssue, description: 'Opens an issue.' }], {
				approval: { required: true },
			})
		).tools;
		const [changed] = (
			await connect(
				[
					{
						...createIssue,
						inputSchema: { ...createIssue.inputSchema, required: ['title', 'teamId'] },
					},
				],
				{ approval: { required: true } },
			)
		).tools;
		expect(reordered?.version).toBe(base?.version);
		expect(redescribed?.version).toBe(base?.version);
		expect(changed?.version).not.toBe(base?.version);
	});

	it('rejects a policy that names a tool that is not mounted', async () => {
		let closed = false;
		const client = {
			...stubClient([createIssue, searchIssues]),
			close: async () => {
				closed = true;
			},
		};
		await expect(
			createMcpConnectionWithClient(
				'linear',
				client,
				{} as Transport,
				{},
				{
					tools: ['search_issues'],
					approval: { required: true, tools: ['create_issue'] },
				},
			),
		).rejects.toThrow(/approval names "create_issue", which is not mounted/);
		expect(closed).toBe(true);
	});

	it('validates and freezes the policy on the connection definition', () => {
		const base = { name: 'linear', url: 'https://mcp.example.test/mcp' };
		const defined = defineMcpConnection({
			...base,
			approval: { required: true, tools: ['create_issue'] },
		});
		expect(Object.isFrozen(defined.approval)).toBe(true);
		expect(Object.isFrozen(defined.approval?.tools)).toBe(true);

		const invalid = (approval: unknown) =>
			defineMcpConnection({ ...base, approval } as McpConnectionDefinition);
		expect(() => invalid(true)).toThrow(/approval must be an object/);
		expect(() => invalid({})).toThrow(/approval must set required: true/);
		expect(() => invalid({ required: true, tool: ['x'] })).toThrow(
			/approval received unknown field "tool"/,
		);
		expect(() => invalid({ required: true, tools: 'create_issue' })).toThrow(
			/approval tools must be an array/,
		);
		expect(() => invalid({ required: true, tools: ['a', 'a'] })).toThrow(
			/approval tools repeats "a"/,
		);
		expect(() => invalid({ required: true, expiresInMs: 0 })).toThrow(
			/approval expiresInMs must be a positive number/,
		);
		expect(() => invalid({ required: true, escalation: 'Notion Edit' })).toThrow(
			/approval escalation must be an escalation group name/,
		);
		expect(() => invalid({ required: true, escalations: ['create_issue'] })).toThrow(
			/approval escalations must map tool names/,
		);
		expect(() =>
			invalid({ required: true, escalations: { create_issue: 'Linear Write' } }),
		).toThrow(/approval escalations\["create_issue"\] must be an escalation group name/);
		expect(() =>
			invalid({
				required: true,
				tools: ['create_issue'],
				escalations: { search_issues: 'linear-read' },
			}),
		).toThrow(/approval escalations names "search_issues", which approval tools does not gate/);

		const grouped = defineMcpConnection({
			...base,
			approval: { required: true, escalations: { create_issue: 'linear-write' } },
		});
		expect(Object.isFrozen(grouped.approval?.escalations)).toBe(true);
	});

	it('puts each gated tool in its own escalation group, falling back to the policy group', async () => {
		const updateIssue: Tool = { ...createIssue, name: 'update_issue', title: 'Update issue' };
		const connection = await connect([createIssue, updateIssue, searchIssues], {
			approval: {
				required: true,
				tools: ['create_issue', 'update_issue', 'search_issues'],
				escalation: 'linear-write',
				escalations: { update_issue: 'linear-update', search_issues: 'linear-read' },
			},
		});
		const [create, update, search] = connection.tools;
		expect(create?.approval?.escalation).toBe('linear-write');
		expect(update?.approval?.escalation).toBe('linear-update');
		expect(search?.approval?.escalation).toBe('linear-read');
	});

	it('leaves a gated tool out of any group when neither map nor policy names one', async () => {
		const connection = await connect([createIssue, searchIssues], {
			approval: { required: true, escalations: { create_issue: 'linear-write' } },
		});
		const [create, search] = connection.tools;
		expect(create?.approval?.escalation).toBe('linear-write');
		expect(search?.approval).toEqual({ required: true });
	});

	it('rejects per-tool groups for tools the server does not mount', async () => {
		await expect(
			connect([createIssue], {
				approval: { required: true, escalations: { delete_issue: 'linear-write' } },
			}),
		).rejects.toThrow(/approval escalations names "delete_issue", which is not gated/);
	});

	it('puts every gated tool in the policy escalation group', async () => {
		const connection = await connect([createIssue, searchIssues], {
			approval: { required: true, tools: ['create_issue'], escalation: 'linear-write' },
		});
		const [create, search] = connection.tools;
		expect(create?.approval).toEqual({
			required: true,
			escalation: 'linear-write',
			presentation: { title: 'Create issue' },
		});
		expect(search?.approval).toBeUndefined();
	});
});

describe('MCP connection lifecycle', () => {
	const echo: Tool = { name: 'echo', inputSchema: { type: 'object' } };

	it('ends the server session and releases the standalone GET stream on close', async () => {
		const server = createFakeMcpServer([echo]);
		const connection = await createMcpConnection({
			name: 'probe',
			url: 'https://mcp.test/mcp',
			fetch: server.fetch,
		});
		await vi.waitFor(() => expect(server.openStreams).toBe(1));

		await connection.close();

		expect(server.openStreams).toBe(0);
		expect(server.deletes).toBe(1);
	});

	it('connects fresh after the cache closes', async () => {
		const server = createFakeMcpServer([echo]);
		const cache = createMcpConnectionCache();
		const definition = { name: 'probe', url: 'https://mcp.test/mcp', fetch: server.fetch };
		const first = await cache.resolve(definition);
		expect(await cache.resolve(definition)).toBe(first);
		await vi.waitFor(() => expect(server.openStreams).toBe(1));

		await cache.close();
		expect(server.openStreams).toBe(0);
		expect(await cache.resolve(definition)).not.toBe(first);

		expect(server.sessions).toBe(2);
		await cache.close();
		expect(server.deletes).toBe(2);
	});
});

describe('MCP missing tools', () => {
	const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
		name,
		description: `${name} description.`,
		inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
		...extra,
	});
	const createIssue = tool('create_issue', {
		annotations: { readOnlyHint: false, destructiveHint: false },
	});
	const searchIssues = tool('search_issues', { annotations: { readOnlyHint: true } });
	const deleteIssue = tool('delete_issue', { annotations: { destructiveHint: true } });
	const runReport = tool('run_report', { execution: { taskSupport: 'required' } });
	const listed = [createIssue, searchIssues, deleteIssue, runReport];

	async function connect(
		selection: Parameters<typeof createMcpConnectionWithClient>[4],
		tools: Tool[] = listed,
	) {
		return createMcpConnectionWithClient(
			'linear',
			stubClient(tools),
			{} as Transport,
			{},
			selection,
		);
	}

	/** Server tool names that mounted, and which of them require approval. */
	function mounted(connection: { tools: { name: string; approval?: unknown }[] }) {
		const name = (tool: { name: string }) => tool.name.replace(/^mcp__linear__/, '');
		return {
			tools: connection.tools.map(name),
			gated: connection.tools.filter((tool) => tool.approval !== undefined).map(name),
		};
	}

	const missingMessage =
		/^\[flue\] MCP server "linear" does not expose "archive_issue" named in the tools allowlist\. Discovered tools: create_issue, search_issues, delete_issue, run_report\.$/;

	describe("default ('error') mode", () => {
		it('rejects a missing allowlisted tool with the unchanged message, with or without the field', async () => {
			for (const missingTools of [undefined, 'error'] as const) {
				await expect(
					connect({ tools: ['create_issue', 'archive_issue'], missingTools }),
				).rejects.toThrow(missingMessage);
			}
		});

		it('rejects an allowlisted tool that requires task-based execution', async () => {
			await expect(connect({ tools: ['create_issue', 'run_report'] })).rejects.toThrow(
				/^\[flue\] MCP tool "run_report" from server "linear" requires task-based execution, which is not supported — remove it from the tools allowlist\.$/,
			);
		});

		it('still rejects approval names that are not mounted', async () => {
			await expect(
				connect({
					tools: ['create_issue'],
					approval: { required: true, tools: ['search_issues'] },
				}),
			).rejects.toThrow(/approval names "search_issues", which is not mounted/);
			await expect(
				connect({ approval: { required: true, tools: ['run_report'] } }),
			).rejects.toThrow(/approval names "run_report", which is not mounted/);
		});
	});

	describe("'skip' mode", () => {
		it('mounts allowlist ∩ listed ∩ callable, in allowlist order', async () => {
			const connection = await connect({
				tools: ['search_issues', 'archive_issue', 'run_report', 'create_issue'],
				missingTools: 'skip',
			});
			expect(mounted(connection)).toEqual({
				tools: ['search_issues', 'create_issue'],
				gated: [],
			});
		});

		it('mounts every callable listed tool without an allowlist', async () => {
			const connection = await connect({ missingTools: 'skip' });
			expect(mounted(connection).tools).toEqual(['create_issue', 'search_issues', 'delete_issue']);
		});

		it('gates the named tools that mounted when some named tools are missing', async () => {
			const connection = await connect({
				tools: ['create_issue', 'search_issues', 'archive_issue'],
				missingTools: 'skip',
				approval: { required: true, tools: ['archive_issue', 'create_issue'] },
			});
			expect(mounted(connection)).toEqual({
				tools: ['create_issue', 'search_issues'],
				gated: ['create_issue'],
			});
		});

		it('gates nothing when every named tool is missing — never every mounted tool', async () => {
			const connection = await connect({
				tools: ['create_issue', 'search_issues', 'archive_issue', 'run_report'],
				missingTools: 'skip',
				approval: { required: true, tools: ['archive_issue', 'run_report'] },
			});
			expect(mounted(connection)).toEqual({
				tools: ['create_issue', 'search_issues'],
				gated: [],
			});
			for (const adapted of connection.tools) expect(adapted.version).toBeUndefined();
		});

		it('gates every mounted tool when approval.tools is omitted', async () => {
			const connection = await connect({
				tools: ['create_issue', 'archive_issue', 'search_issues'],
				missingTools: 'skip',
				approval: { required: true },
			});
			expect(mounted(connection)).toEqual({
				tools: ['create_issue', 'search_issues'],
				gated: ['create_issue', 'search_issues'],
			});
		});

		it("drops a skipped tool's escalation group and keeps the rest", async () => {
			const connection = await connect({
				tools: ['create_issue', 'delete_issue', 'archive_issue'],
				missingTools: 'skip',
				approval: {
					required: true,
					tools: ['create_issue', 'delete_issue', 'archive_issue'],
					escalation: 'linear-write',
					escalations: { archive_issue: 'linear-archive', delete_issue: 'linear-delete' },
				},
			});
			expect(mounted(connection).gated).toEqual(['create_issue', 'delete_issue']);
			const [create, remove] = connection.tools;
			expect(create?.approval?.escalation).toBe('linear-write');
			expect(remove?.approval?.escalation).toBe('linear-delete');
		});

		it('still rejects approval names that are neither mounted nor skipped', async () => {
			await expect(
				connect({
					tools: ['create_issue', 'archive_issue'],
					missingTools: 'skip',
					approval: { required: true, tools: ['search_issues'] },
				}),
			).rejects.toThrow(/approval names "search_issues", which is not mounted/);
			await expect(
				connect({
					tools: ['create_issue', 'archive_issue'],
					missingTools: 'skip',
					approval: { required: true, escalations: { search_issues: 'linear-read' } },
				}),
			).rejects.toThrow(/approval escalations names "search_issues", which is not gated/);
		});

		it('fails the connection when no allowlisted tool can mount', async () => {
			await expect(
				connect({ tools: ['archive_issue', 'run_report'], missingTools: 'skip' }),
			).rejects.toThrow(missingMessage);
			await expect(connect({ tools: ['run_report'], missingTools: 'skip' })).rejects.toThrow(
				/^\[flue\] MCP tool "run_report" from server "linear" requires task-based execution/,
			);
		});

		it('rejects a repeated allowlist name in both modes', async () => {
			for (const missingTools of ['error', 'skip'] as const) {
				await expect(
					connect({ tools: ['create_issue', 'create_issue'], missingTools }),
				).rejects.toThrow(/tools allowlist repeats "create_issue"/);
			}
		});

		it('records what it skipped once per connect', async () => {
			const connection = await connect({
				tools: ['create_issue', 'archive_issue', 'run_report'],
				missingTools: 'skip',
			});
			expect(readMcpSkippedTools(connection)).toEqual({
				fresh: true,
				skipped: { name: 'linear', missing: ['archive_issue'], unsupported: ['run_report'] },
			});
			expect(readMcpSkippedTools(connection)?.fresh).toBe(false);
			expect(
				readMcpSkippedTools(await connect({ tools: ['create_issue'], missingTools: 'skip' })),
			).toBeUndefined();
		});
	});

	describe('onToolDiscovery', () => {
		it('reports the full paginated listing before selection, frozen', async () => {
			const discoveries: McpToolDiscovery[] = [];
			const pages: Record<string, { tools: Tool[]; nextCursor?: string }> = {
				'': { tools: [createIssue, searchIssues], nextCursor: 'page-2' },
				'page-2': { tools: [deleteIssue, runReport] },
			};
			const client = {
				...stubClient([]),
				listTools: async (params?: { cursor?: string }) => pages[params?.cursor ?? ''],
			} as unknown as ReturnType<typeof stubClient>;
			await createMcpConnectionWithClient(
				'linear',
				client,
				{} as Transport,
				{},
				{
					tools: ['create_issue', 'archive_issue', 'run_report'],
					missingTools: 'skip',
					onToolDiscovery: (discovery) => discoveries.push(discovery),
				},
			);
			expect(discoveries).toEqual([
				{
					server: 'linear',
					offered: [
						{
							name: 'create_issue',
							description: 'create_issue description.',
							readOnlyHint: false,
							destructiveHint: false,
						},
						{
							name: 'search_issues',
							description: 'search_issues description.',
							readOnlyHint: true,
						},
						{
							name: 'delete_issue',
							description: 'delete_issue description.',
							destructiveHint: true,
						},
						{ name: 'run_report', description: 'run_report description.' },
					],
					missing: ['archive_issue'],
					unsupported: ['run_report'],
				},
			]);
			const [discovery] = discoveries;
			expect(Object.isFrozen(discovery)).toBe(true);
			expect(Object.isFrozen(discovery?.offered)).toBe(true);
			expect(discovery?.offered.every((entry) => Object.isFrozen(entry))).toBe(true);
			expect(Object.isFrozen(discovery?.missing)).toBe(true);
			expect(Object.isFrozen(discovery?.unsupported)).toBe(true);
		});

		it('reports in error mode, including when selection then fails', async () => {
			const onToolDiscovery = vi.fn();
			await expect(
				connect({ tools: ['create_issue', 'archive_issue'], onToolDiscovery }),
			).rejects.toThrow(missingMessage);
			await expect(
				connect({ tools: ['archive_issue', 'archive_issue'], onToolDiscovery }),
			).rejects.toThrow(/repeats/);
			await expect(
				connect({ tools: ['archive_issue'], missingTools: 'skip', onToolDiscovery }),
			).rejects.toThrow(missingMessage);
			expect(onToolDiscovery.mock.calls.map(([discovery]) => discovery.missing)).toEqual([
				['archive_issue'],
				['archive_issue'],
				['archive_issue'],
			]);
		});

		it('reports no missing names and every task-required tool without an allowlist', async () => {
			const onToolDiscovery = vi.fn();
			await connect({ onToolDiscovery });
			expect(onToolDiscovery).toHaveBeenCalledWith(
				expect.objectContaining({ missing: [], unsupported: ['run_report'] }),
			);
		});

		it('logs a throwing or mutating callback and leaves the connection unaffected', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const connection = await connect({
					tools: ['create_issue', 'archive_issue'],
					missingTools: 'skip',
					onToolDiscovery: (discovery) => {
						// Strict-mode writes to the frozen snapshot throw.
						(discovery.missing as string[]).length = 0;
						(discovery.offered as unknown[]).push({ name: 'archive_issue' });
					},
				});
				expect(mounted(connection).tools).toEqual(['create_issue']);
				expect(readMcpSkippedTools(connection)?.skipped.missing).toEqual(['archive_issue']);

				const thrown = await connect({
					tools: ['create_issue'],
					onToolDiscovery: () => {
						throw new Error('reporter down');
					},
				});
				expect(mounted(thrown).tools).toEqual(['create_issue']);
				expect(warn).toHaveBeenCalledWith(
					'[flue] MCP server "linear" onToolDiscovery threw; the connection is unaffected.',
					expect.objectContaining({ message: 'reporter down' }),
				);
			} finally {
				warn.mockRestore();
			}
		});

		it('fires per actual connect, not per cache hit', async () => {
			const server = createFakeMcpServer([createIssue]);
			const cache = createMcpConnectionCache();
			const onToolDiscovery = vi.fn();
			const definition: McpConnectionDefinition = {
				name: 'linear',
				url: 'https://mcp.test/mcp',
				fetch: server.fetch,
				tools: ['create_issue', 'archive_issue'],
				missingTools: 'skip',
				onToolDiscovery,
			};
			const first = await cache.resolve(definition);
			expect(await cache.resolve(definition)).toBe(first);
			expect(onToolDiscovery).toHaveBeenCalledTimes(1);
			expect(readMcpSkippedTools(first)?.fresh).toBe(true);
			expect(readMcpSkippedTools(await cache.resolve(definition))?.fresh).toBe(false);

			await cache.close();
			const second = await cache.resolve(definition);
			expect(onToolDiscovery).toHaveBeenCalledTimes(2);
			expect(readMcpSkippedTools(second)?.fresh).toBe(true);
			await cache.close();
		});
	});

	it('validates and keeps the new fields on the connection definition', () => {
		const base = { name: 'linear', url: 'https://mcp.example.test/mcp' };
		const onToolDiscovery = () => {};
		const defined = defineMcpConnection({ ...base, missingTools: 'skip', onToolDiscovery });
		expect(defined.missingTools).toBe('skip');
		expect(defined.onToolDiscovery).toBe(onToolDiscovery);
		const invalid = (extra: object) =>
			defineMcpConnection({ ...base, ...extra } as McpConnectionDefinition);
		expect(() => invalid({ missingTools: 'ignore' })).toThrow(
			/missingTools must be 'error' or 'skip'/,
		);
		expect(() => invalid({ onToolDiscovery: 'log' })).toThrow(/onToolDiscovery must be a function/);
	});
});
