import type { Client, Tool, Transport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { defineMcpConnection } from './hooks/use-mcp-connection.ts';
import { createMcpConnectionWithClient, type McpConnectionDefinition } from './mcp.ts';
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
		return createMcpConnectionWithClient('linear', stubClient(tools), {} as Transport, {}, selection);
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
			createMcpConnectionWithClient('linear', client, {} as Transport, {}, {
				tools: ['search_issues'],
				approval: { required: true, tools: ['create_issue'] },
			}),
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
	});
});
