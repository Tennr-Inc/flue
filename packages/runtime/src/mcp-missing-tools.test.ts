import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';
import type { Tool } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { init, instrument, useMcpConnection, useModel } from './index.ts';
import type { McpToolDiscovery } from './mcp.ts';
import { sqlite, start } from './node/index.ts';
import { renderMcpSkippedToolsSignalBody } from './resources.ts';
import { resetModelsForTests } from './runtime/providers.ts';
import { createFakeMcpServer } from './test-utils/fake-mcp-server.ts';
import type { FlueObservation } from './types.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	resetModelsForTests();
});

describe('MCP skipped-tools signal', () => {
	it('names missing and task-required tools per server, from the allowlist', () => {
		expect(
			renderMcpSkippedToolsSignalBody([
				{ name: 'datadog', missing: ['create_monitor', 'edit_monitor'], unsupported: [] },
				{ name: 'metabase', missing: ['run_query'], unsupported: ['export_card'] },
			]),
		).toBe(
			[
				'MCP server "datadog" does not offer these tools, so they are not mounted: "create_monitor", "edit_monitor".',
				'MCP server "metabase" does not offer these tools, so they are not mounted: "run_query".',
				'MCP server "metabase" tools that require task-based execution are not mounted: "export_card".',
			].join('\n'),
		);
	});
});

describe('MCP missing tools in a running agent', () => {
	const tool = (name: string): Tool => ({
		name,
		description: `${name} description.`,
		inputSchema: { type: 'object' },
	});

	async function run(definitionExtra: { optional?: boolean; tools: string[] }) {
		const server = createFakeMcpServer([tool('search_monitors'), tool('get_monitor')]);
		const faux = fauxProvider({ models: [{ id: 'main' }] });
		const requests: Array<{ tools: string[]; text: string }> = [];
		const reply =
			(text: string): FauxResponseFactory =>
			(context) => {
				requests.push({
					// Pi carries the tool set on messages as added/removed deltas.
					tools: context.messages
						.flatMap((message) =>
							'toolsAdded' in message && Array.isArray(message.toolsAdded)
								? message.toolsAdded.map((entry: { name: string }) => entry.name)
								: [],
						)
						.filter((name) => name.startsWith('mcp__')),
					text: JSON.stringify(context.messages),
				});
				return fauxAssistantMessage(text);
			};
		faux.setResponses([reply('One.'), reply('Two.')]);
		const discoveries: McpToolDiscovery[] = [];
		function MonitorAgent() {
			useModel('faux/main', { compaction: false });
			useMcpConnection({
				name: 'datadog',
				url: 'https://mcp.test/mcp',
				fetch: server.fetch,
				missingTools: 'skip',
				onToolDiscovery: (discovery) => discoveries.push(discovery),
				...definitionExtra,
			});
			return 'Watch monitors.';
		}
		const logs: Array<{ message: string; attributes?: Record<string, unknown> }> = [];
		const dispose = instrument({
			observe: (event: FlueObservation) => {
				if (event.type === 'log' && event.level === 'warn') {
					logs.push({ message: event.message, attributes: event.attributes });
				}
			},
			interceptor: (_operation, _context, next) => next(),
			dispose() {},
		});
		const runtime = await start({
			agents: [MonitorAgent],
			db: sqlite(),
			providers: [faux.provider],
			env: {},
		});
		const agent = init(MonitorAgent, { id: 'monitor-agent' });
		cleanups.push(async () => {
			await agent.abort();
			await runtime.stop();
			await dispose();
		});
		await expect(agent.read(await agent.dispatch('First.'))).resolves.toMatchObject({
			text: 'One.',
		});
		await expect(agent.read(await agent.dispatch('Second.'))).resolves.toMatchObject({
			text: 'Two.',
		});
		return { server, requests, discoveries, logs };
	}

	it('warns once per connect and tells the model on every submission', async () => {
		const { server, requests, discoveries, logs } = await run({
			tools: ['create_monitor', 'search_monitors', 'edit_monitor'],
		});
		// One connect: the node coordinator caches the connection per instance.
		expect(server.sessions).toBe(1);
		expect(discoveries.map((entry) => entry.missing)).toEqual([['create_monitor', 'edit_monitor']]);
		expect(logs).toEqual([
			{
				message:
					'MCP server "datadog" does not offer some allowlisted tools; they are not mounted.',
				attributes: {
					server: 'datadog',
					missingTools: ['create_monitor', 'edit_monitor'],
					unsupportedTools: [],
				},
			},
		]);
		const signal =
			'MCP server \\"datadog\\" does not offer these tools, so they are not mounted: \\"create_monitor\\", \\"edit_monitor\\".';
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request.tools).toEqual(['mcp__datadog__search_monitors']);
			expect(request.text).toContain(signal);
		}
	});

	it('reports an optional connection unavailable when nothing allowlisted mounts', async () => {
		const { requests, discoveries, logs } = await run({
			optional: true,
			tools: ['create_monitor'],
		});
		// No connection is cached, so each submission connects and reports again.
		expect(discoveries).toHaveLength(2);
		expect(logs.map((entry) => entry.message)).toEqual([
			'MCP server "datadog" is unavailable; its tools are not mounted for this submission.',
			'MCP server "datadog" is unavailable; its tools are not mounted for this submission.',
		]);
		expect(requests[0]?.tools).toEqual([]);
		expect(requests[0]?.text).toContain(
			'MCP server \\"datadog\\" is unavailable for this response',
		);
	});
});
