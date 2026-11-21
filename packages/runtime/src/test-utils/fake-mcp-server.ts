import type { Tool } from '@modelcontextprotocol/client';

/** An in-memory streamable-HTTP MCP server, served through a definition's `fetch`. */
export interface FakeMcpServer {
	fetch: typeof fetch;
	/** Sessions opened by `initialize`. */
	readonly sessions: number;
	/** Standalone GET streams the client holds open right now. */
	readonly openStreams: number;
	/** Session `DELETE`s received. */
	readonly deletes: number;
}

export function createFakeMcpServer(tools: Tool[]): FakeMcpServer {
	let sessions = 0;
	let openStreams = 0;
	let deletes = 0;
	const json = (body: unknown, headers: Record<string, string> = {}) =>
		new Response(JSON.stringify(body), {
			headers: { 'content-type': 'application/json', ...headers },
		});
	const openStream = (signal: AbortSignal | null | undefined) => {
		signal?.throwIfAborted();
		openStreams++;
		let open = true;
		const release = () => {
			if (!open) return;
			open = false;
			openStreams--;
		};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				signal?.addEventListener(
					'abort',
					() => {
						release();
						controller.error(signal.reason);
					},
					{ once: true },
				);
			},
			cancel: release,
		});
		return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
	};
	const serve = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const method = init?.method ?? 'GET';
		if (method === 'DELETE') {
			deletes++;
			return new Response(null, { status: 200 });
		}
		if (method === 'GET') return openStream(init?.signal);
		const message = JSON.parse(String(init?.body)) as {
			id?: number | string;
			method: string;
			params?: { protocolVersion?: string };
		};
		if (message.id === undefined) return new Response(null, { status: 202 });
		switch (message.method) {
			case 'initialize':
				sessions++;
				return json(
					{
						jsonrpc: '2.0',
						id: message.id,
						result: {
							protocolVersion: message.params?.protocolVersion,
							capabilities: { tools: {} },
							serverInfo: { name: 'fake', version: '1.0.0' },
						},
					},
					{ 'mcp-session-id': `session-${sessions}` },
				);
			case 'tools/list':
				return json({ jsonrpc: '2.0', id: message.id, result: { tools } });
			default:
				return json({
					jsonrpc: '2.0',
					id: message.id,
					error: { code: -32601, message: `Unknown method ${message.method}` },
				});
		}
	};
	return {
		fetch: serve as typeof fetch,
		get sessions() {
			return sessions;
		},
		get openStreams() {
			return openStreams;
		},
		get deletes() {
			return deletes;
		},
	};
}
