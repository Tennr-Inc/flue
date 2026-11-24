import {
	type AuthProvider,
	type CallToolResult,
	Client,
	SSEClientTransport,
	StreamableHTTPClientTransport,
	type Tool,
	type Transport,
} from '@modelcontextprotocol/client';
import { version as runtimeVersion } from '../package.json' with { type: 'json' };
import type {
	McpApprovalPolicy,
	McpAuth,
	McpConnectionDefinition,
	McpDiscoveredTool,
	McpSkippedTools,
	McpToolDiscovery,
	McpTransport,
} from './mcp-types.ts';
import { registerPreparedToolAdapter } from './tool-adapter.ts';
import type { ToolApprovalPolicy } from './tool-approval.ts';
import type { ToolDefinition } from './types.ts';

export type {
	McpApprovalPolicy,
	McpAuth,
	McpConnectionDefinition,
	McpDiscoveredTool,
	McpToolAnnotations,
	McpToolDiscovery,
	McpTransport,
} from './mcp-types.ts';

/** Request options in the MCP SDK's shape (its `timeout` is milliseconds). */
type McpRequestOptions = {
	timeout?: number;
	resetTimeoutOnProgress?: boolean;
};

/** Connection returned by {@link createMcpConnection}. */
export interface McpConnection {
	/** Server name supplied to {@link createMcpConnection}. */
	name: string;
	/** MCP tools adapted into ordinary Flue tool definitions. */
	tools: ToolDefinition[];
	/** Close the underlying MCP client connection. */
	close(): Promise<void>;
}

/**
 * Resolves `useMcpConnection()` declarations to live connections.
 * Coordinators inject a per-instance caching resolver; a context without one
 * connects fresh at every harness initialization.
 */
export interface McpConnectionResolver {
	resolve(definition: McpConnectionDefinition): Promise<McpConnection>;
}

/** A caching {@link McpConnectionResolver} with a teardown for coordinator shutdown. */
export interface McpConnectionCache extends McpConnectionResolver {
	/** Close every cached connection and forget them all. */
	close(): Promise<void>;
}

/**
 * A per-instance MCP connection cache: the first declaration of a server
 * name connects; later resolves reuse the live connection until the owner
 * calls `close()`, so definitions are read at first connect (an `auth`
 * resolver stays per-request). Concurrent resolves of one name share a
 * single in-flight connect. A failed connect is evicted immediately — a
 * transient outage must not brick the instance, so the next submission
 * retries with a freshly read definition. `close()` forgets every entry
 * synchronously, so a resolve that races a close connects fresh.
 */
export function createMcpConnectionCache(): McpConnectionCache {
	const connections = new Map<string, Promise<McpConnection>>();
	return {
		resolve(definition: McpConnectionDefinition): Promise<McpConnection> {
			const cached = connections.get(definition.name);
			if (cached) return cached;
			const pending = createMcpConnection(definition);
			connections.set(definition.name, pending);
			pending.catch(() => {
				if (connections.get(definition.name) === pending) {
					connections.delete(definition.name);
				}
			});
			return pending;
		},
		async close(): Promise<void> {
			const pending = [...connections.values()];
			connections.clear();
			await Promise.allSettled(pending.map(async (connection) => (await connection).close()));
		},
	};
}

/** Allowlisted tools each connection's skip mode left unmounted, by connection. */
const skippedToolsByConnection = new WeakMap<McpConnection, McpSkippedTools>();
/** Connections whose skipped tools no submission has reported yet. */
const unreportedSkips = new WeakSet<McpConnection>();

/**
 * The allowlisted tools `missingTools: 'skip'` left unmounted on a
 * connection, or `undefined` when it skipped none. `fresh` is true for the
 * first caller only, so a cached connection's skip is logged once per actual
 * connect while every submission still tells its model.
 */
export function readMcpSkippedTools(
	connection: McpConnection,
): { skipped: McpSkippedTools; fresh: boolean } | undefined {
	const skipped = skippedToolsByConnection.get(connection);
	if (!skipped) return undefined;
	const fresh = unreportedSkips.delete(connection);
	return { skipped, fresh };
}

type McpClient = Pick<Client, 'callTool' | 'close' | 'connect' | 'listTools'>;

/**
 * Connects to a remote MCP server described by a
 * {@link McpConnectionDefinition} and adapts its listed tools into ordinary
 * Flue tool definitions.
 *
 * Adapted tool names use `mcp__<server>__<tool>`. Unsupported characters are
 * replaced with underscores, and duplicate adapted names are rejected. Close
 * the returned connection when its tools are no longer needed.
 */
export async function createMcpConnection(
	definition: McpConnectionDefinition,
): Promise<McpConnection> {
	const url = definition.url instanceof URL ? definition.url : new URL(definition.url);
	const requestInit = mergeRequestInit(definition.requestInit, definition.headers);
	const transport = createTransport(
		url,
		definition.transport ?? 'streamable-http',
		requestInit,
		definition.fetch,
		definition.auth === undefined ? undefined : createAuthProvider(definition.auth),
	);
	const client = new Client({
		name: 'flue',
		version: runtimeVersion,
	});

	return createMcpConnectionWithClient(
		definition.name,
		client,
		transport,
		{
			timeout: definition.timeoutMs,
			resetTimeoutOnProgress: definition.resetTimeoutOnProgress,
		},
		{
			tools: definition.tools,
			approval: definition.approval,
			missingTools: definition.missingTools,
			onToolDiscovery: definition.onToolDiscovery,
		},
	);
}

/** How a connection applies its allowlist and approval policy to the listing. */
interface McpToolSelectionOptions {
	tools?: readonly string[];
	approval?: McpApprovalPolicy;
	missingTools?: 'error' | 'skip';
	onToolDiscovery?: (discovery: McpToolDiscovery) => void;
}

export async function createMcpConnectionWithClient(
	name: string,
	client: McpClient,
	transport: Transport,
	requestOptions: McpRequestOptions = {},
	selection: McpToolSelectionOptions = {},
): Promise<McpConnection> {
	try {
		await client.connect(transport);
		let page = await client.listTools(undefined, requestOptions);
		const tools = [...page.tools];
		const seenCursors = new Set<string>();
		while (page.nextCursor !== undefined) {
			if (seenCursors.has(page.nextCursor)) {
				throw new Error(
					`[flue] MCP server "${name}" repeated tools/list cursor ${JSON.stringify(page.nextCursor)} during tool discovery.`,
				);
			}
			seenCursors.add(page.nextCursor);
			page = await client.listTools({ cursor: page.nextCursor }, requestOptions);
			tools.push(...page.tools);
		}

		const discovery = discoverMcpTools(name, tools, selection.tools);
		reportMcpToolDiscovery(selection.onToolDiscovery, discovery);
		const skip = selection.missingTools === 'skip';
		const selected = selectMcpTools(name, tools, selection.tools, discovery, skip);
		const connection: McpConnection = {
			name,
			tools: await createMcpTools(
				name,
				client,
				selected.tools,
				requestOptions,
				selection.approval,
				new Set(selected.skipped),
			),
			close: () => closeMcpClient(client, transport),
		};
		if (selected.skipped.length > 0) {
			const skipped = new Set(selected.skipped);
			skippedToolsByConnection.set(
				connection,
				Object.freeze({
					name,
					missing: Object.freeze(discovery.missing.filter((tool) => skipped.has(tool))),
					unsupported: Object.freeze(discovery.unsupported.filter((tool) => skipped.has(tool))),
				}),
			);
			unreportedSkips.add(connection);
		}
		return connection;
	} catch (error) {
		await client.close().catch(() => undefined);
		throw error;
	}
}

/** How long a closing connection waits for the server to acknowledge its session `DELETE`. */
const MCP_SESSION_TERMINATE_TIMEOUT_MS = 2_000;

/**
 * Ends the server session, then the client. The client's own `close()` only
 * aborts in-flight requests and the standalone GET stream; it never sends the
 * streamable-HTTP session `DELETE`, so the server would keep the session
 * until its own idle timeout. The `DELETE` is best-effort and bounded:
 * `client.close()` aborts it if the server is slow.
 */
async function closeMcpClient(client: McpClient, transport: Transport): Promise<void> {
	const terminateSession = (transport as { terminateSession?: () => Promise<void> })
		.terminateSession;
	if (typeof terminateSession === 'function') {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			terminateSession.call(transport).catch(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, MCP_SESSION_TERMINATE_TIMEOUT_MS);
			}),
		]);
		clearTimeout(timer);
	}
	await client.close();
}

/**
 * Adapt the `auth` credential to the MCP SDK's {@link AuthProvider}: the
 * transport calls `token()` before every request, and on a 401 awaits
 * `onUnauthorized` and retries once — re-resolving the token, so the
 * application's credential store is the refresh policy.
 */
function createAuthProvider(auth: McpAuth): AuthProvider {
	const resolveToken = typeof auth === 'function' ? auth : () => auth;
	return {
		token: async () => resolveToken(),
		onUnauthorized: async () => {},
	};
}

/**
 * What the listing offers against the allowlist, computed before selection so
 * `onToolDiscovery` sees it whether or not selection then fails.
 */
function discoverMcpTools(
	serverName: string,
	discovered: Tool[],
	allowlist: readonly string[] | undefined,
): McpToolDiscovery {
	const byName = new Map(discovered.map((tool) => [tool.name, tool]));
	const named = allowlist === undefined ? undefined : [...new Set(allowlist)];
	const unsupported = (named ?? discovered.map((tool) => tool.name)).filter(
		(name) => byName.get(name)?.execution?.taskSupport === 'required',
	);
	return Object.freeze({
		server: serverName,
		offered: Object.freeze(discovered.map(discoveredTool)),
		missing: Object.freeze((named ?? []).filter((name) => !byName.has(name))),
		unsupported: Object.freeze(unsupported),
	});
}

function discoveredTool(tool: Tool): McpDiscoveredTool {
	return Object.freeze({
		name: tool.name,
		...(tool.description === undefined ? {} : { description: tool.description }),
		...(tool.annotations?.readOnlyHint === undefined
			? {}
			: { readOnlyHint: tool.annotations.readOnlyHint }),
		...(tool.annotations?.destructiveHint === undefined
			? {}
			: { destructiveHint: tool.annotations.destructiveHint }),
	});
}

/** Call `onToolDiscovery`; a throw is logged and never reaches the connection. */
function reportMcpToolDiscovery(
	callback: ((discovery: McpToolDiscovery) => void) | undefined,
	discovery: McpToolDiscovery,
): void {
	if (!callback) return;
	try {
		callback(discovery);
	} catch (error) {
		console.warn(
			`[flue] MCP server "${discovery.server}" onToolDiscovery threw; the connection is unaffected.`,
			error,
		);
	}
}

/**
 * Apply the `tools` allowlist to the discovered listing, in allowlist order.
 * By default every allowlisted name must exist and be callable — a typo or an
 * unsupported tool must fail loud, not silently narrow the tool set. In skip
 * mode those names are dropped and returned as `skipped`, unless nothing
 * would mount. Without an allowlist, every callable listed tool mounts.
 */
function selectMcpTools(
	serverName: string,
	discovered: Tool[],
	allowlist: readonly string[] | undefined,
	discovery: McpToolDiscovery,
	skip: boolean,
): { tools: Tool[]; skipped: string[] } {
	if (allowlist === undefined) {
		return {
			tools: discovered.filter((tool) => {
				if (tool.execution?.taskSupport !== 'required') return true;
				console.warn(
					`[flue] Skipping MCP tool "${tool.name}" from server "${serverName}": it requires task-based execution, which is not supported.`,
				);
				return false;
			}),
			// Approval names for these tools still fail in 'error' mode, as before.
			skipped: skip ? [...discovery.unsupported] : [],
		};
	}
	const byName = new Map(discovered.map((tool) => [tool.name, tool]));
	const duplicates = allowlist.filter((name, index) => allowlist.indexOf(name) !== index);
	if (duplicates.length > 0) {
		throw new Error(
			`[flue] MCP server "${serverName}" tools allowlist repeats ${formatToolNames(duplicates)}.`,
		);
	}
	const missingError = () =>
		new Error(
			`[flue] MCP server "${serverName}" does not expose ${formatToolNames(discovery.missing)} named in the tools allowlist. Discovered tools: ${
				discovered.map((tool) => tool.name).join(', ') || '(none)'
			}.`,
		);
	const unsupportedError = (name: string) =>
		new Error(
			`[flue] MCP tool "${name}" from server "${serverName}" requires task-based execution, which is not supported — remove it from the tools allowlist.`,
		);
	const skipped = new Set([...discovery.missing, ...discovery.unsupported]);
	if (!skip) {
		if (discovery.missing.length > 0) throw missingError();
		const [unsupported] = allowlist.filter((name) => skipped.has(name));
		if (unsupported !== undefined) throw unsupportedError(unsupported);
		return { tools: allowlist.map((name) => byName.get(name) as Tool), skipped: [] };
	}
	const tools = allowlist
		.filter((name) => !skipped.has(name))
		.map((name) => byName.get(name) as Tool);
	if (tools.length === 0 && skipped.size > 0) {
		// Nothing allowlisted can mount: fail as 'error' mode would, so an
		// optional connection is reported unavailable rather than empty.
		if (discovery.missing.length > 0) throw missingError();
		throw unsupportedError(discovery.unsupported[0] as string);
	}
	return { tools, skipped: allowlist.filter((name) => skipped.has(name)) };
}

function formatToolNames(names: readonly string[]): string {
	return [...new Set(names)].map((name) => JSON.stringify(name)).join(', ');
}

function createTransport(
	url: URL,
	transport: McpTransport,
	requestInit: RequestInit,
	fetchImpl: typeof fetch | undefined,
	authProvider: AuthProvider | undefined,
) {
	if (transport === 'sse') {
		return new SSEClientTransport(url, {
			requestInit,
			fetch: fetchImpl,
			authProvider,
		});
	}
	return new StreamableHTTPClientTransport(url, {
		requestInit,
		fetch: fetchImpl,
		authProvider,
	});
}

async function createMcpTools(
	serverName: string,
	client: McpClient,
	tools: Tool[],
	requestOptions: McpRequestOptions,
	approval: McpApprovalPolicy | undefined,
	skipped: ReadonlySet<string>,
): Promise<ToolDefinition[]> {
	const names = new Set<string>();

	const gated = selectGatedMcpTools(serverName, tools, approval, skipped);
	// A group for a tool skip mode dropped is dropped with it; any other
	// ungated name is a policy error.
	const regrouped = Object.keys(approval?.escalations ?? {}).filter(
		(name) => !gated.has(name) && !skipped.has(name),
	);
	if (regrouped.length > 0) {
		throw new Error(
			`[flue] MCP server "${serverName}" approval escalations names ${formatToolNames(regrouped)}, which ${regrouped.length === 1 ? 'is' : 'are'} not gated.`,
		);
	}
	const approvalVersions = new Map<string, string>();
	for (const tool of tools) {
		if (gated.has(tool.name)) {
			approvalVersions.set(tool.name, await mcpToolApprovalVersion(tool));
		}
	}

	return tools.map((tool) => {
		const toolName = createToolName(serverName, tool.name);
		if (names.has(toolName)) {
			throw new Error(
				`[flue] MCP tools from server "${serverName}" produced duplicate tool name "${toolName}".`,
			);
		}
		names.add(toolName);

		const definition: ToolDefinition = {
			name: toolName,
			description: createToolDescription(serverName, tool),
			input: undefined,
			output: undefined,
			// Carry the server's `tools/list` annotations through so application
			// code can gate on readOnlyHint / destructiveHint / idempotentHint /
			// openWorldHint. The copy is frozen like the definition itself —
			// adapted tools are data, not handles.
			...(tool.annotations === undefined
				? {}
				: { annotations: Object.freeze({ ...tool.annotations }) }),
			...(approval && gated.has(tool.name)
				? {
						version: approvalVersions.get(tool.name) as string,
						approval: createMcpToolApproval(tool, approval),
					}
				: {}),
			run() {
				throw new Error('[flue] MCP tools execute through the internal adapter.');
			},
		};
		registerPreparedToolAdapter(definition, {
			parameters: normalizeInputSchema(tool.inputSchema),
			async execute(args, signal) {
				if (signal?.aborted) throw new Error('Operation aborted');
				// The client validates structured output against the tool's
				// declared output schema itself and surfaces a mismatch as an
				// error — nothing to re-check here.
				const result: CallToolResult = await client.callTool(
					{
						name: tool.name,
						arguments: args,
					},
					{ ...requestOptions, signal },
				);
				const text = formatMcpResult(result);
				if (result.isError) {
					throw new Error(text);
				}
				return text;
			},
		});
		return Object.freeze(definition);
	});
}

/**
 * Resolve which callable tools the approval policy gates, by the server's own
 * names. Omitted `tools` gates everything mounted; a named tool that is not
 * mounted must fail loud — a typo would otherwise leave a tool ungated —
 * unless skip mode dropped it. A policy whose named tools were all skipped
 * gates nothing: it never falls back to gating every mounted tool.
 */
function selectGatedMcpTools(
	serverName: string,
	callable: Tool[],
	approval: McpApprovalPolicy | undefined,
	skipped: ReadonlySet<string>,
): ReadonlySet<string> {
	if (!approval) return new Set();
	const mounted = callable.map((tool) => tool.name);
	if (approval.tools === undefined) return new Set(mounted);
	const named = approval.tools.filter((name) => !skipped.has(name));
	const unknown = named.filter((name) => !mounted.includes(name));
	if (unknown.length > 0) {
		throw new Error(
			`[flue] MCP server "${serverName}" approval names ${formatToolNames(unknown)}, which ${unknown.length === 1 ? 'is' : 'are'} not mounted. Mounted tools: ${
				mounted.join(', ') || '(none)'
			}.`,
		);
	}
	return new Set(named);
}

function createMcpToolApproval(tool: Tool, policy: McpApprovalPolicy): ToolApprovalPolicy {
	const title = tool.title ?? tool.annotations?.title;
	const escalation = policy.escalations?.[tool.name] ?? policy.escalation;
	return Object.freeze({
		required: true,
		...(policy.expiresInMs !== undefined ? { expiresInMs: policy.expiresInMs } : {}),
		...(escalation !== undefined ? { escalation } : {}),
		// Server-supplied text: a label for the approval UI, never a substitute
		// for showing the tool name and arguments.
		...(title ? { presentation: Object.freeze({ title }) } : {}),
	});
}

/**
 * The approval version of a gated MCP tool: a digest of its name and the
 * normalized input schema the model's arguments were validated against. An
 * approval captured under one schema never executes under another — the
 * server can change its tools without any application deploy, so there is no
 * author-maintained version to bump.
 */
async function mcpToolApprovalVersion(tool: Tool): Promise<string> {
	const preimage = `flue-mcp-tool-approval\n${tool.name}\n${canonicalJson(
		normalizeInputSchema(tool.inputSchema),
	)}`;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preimage));
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return `mcp:${hex.slice(0, 32)}`;
}

/** JSON with object keys sorted, so a server's key order never changes a version. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

function mergeRequestInit(
	requestInit: RequestInit | undefined,
	headers: HeadersInit | undefined,
): RequestInit {
	if (!headers) return requestInit ?? {};
	const mergedHeaders = new Headers(requestInit?.headers);
	for (const [key, value] of new Headers(headers)) {
		mergedHeaders.set(key, value);
	}
	return {
		...requestInit,
		headers: mergedHeaders,
	};
}

function createToolName(serverName: string, toolName: string): string {
	return `mcp__${sanitizeToolNamePart(serverName)}__${sanitizeToolNamePart(toolName)}`;
}

function sanitizeToolNamePart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
	return sanitized || 'unnamed';
}

function createToolDescription(serverName: string, tool: Tool): string {
	const parts: string[] = [];
	// The adapted name parses back to the original ("mcp__linear__create_issue")
	// unless sanitization altered a part — only then does the mapping need
	// spelling out, so server descriptions that cross-reference sibling tools
	// by their original names stay followable.
	const sanitized =
		sanitizeToolNamePart(serverName) !== serverName ||
		sanitizeToolNamePart(tool.name) !== tool.name;
	if (sanitized) parts.push(`MCP tool "${tool.name}" from server "${serverName}".`);
	const title = tool.title ?? tool.annotations?.title;
	if (title && title !== tool.name) parts.push(`Title: ${title}.`);
	if (tool.description) parts.push(tool.description);
	if (parts.length === 0) parts.push(`MCP tool "${tool.name}" from server "${serverName}".`);
	return parts.join(' ');
}

function normalizeInputSchema(schema: Tool['inputSchema']): object {
	return {
		...schema,
		type: schema.type ?? 'object',
		properties: schema.properties ?? {},
		required: schema.required,
	};
}

function formatMcpResult(result: CallToolResult): string {
	const parts: string[] = [];

	if (result.structuredContent !== undefined) {
		parts.push(`Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`);
	}

	for (const item of result.content ?? []) {
		if (item.type === 'text') {
			parts.push(item.text);
			continue;
		}
		if (item.type === 'image') {
			parts.push(`[Image: ${item.mimeType}, ${item.data.length} base64 chars]`);
			continue;
		}
		if (item.type === 'audio') {
			parts.push(`[Audio: ${item.mimeType}, ${item.data.length} base64 chars]`);
			continue;
		}
		if (item.type === 'resource') {
			const resource = item.resource;
			if ('text' in resource) {
				parts.push(`[Resource: ${resource.uri}]\n${resource.text}`);
			} else {
				parts.push(`[Resource: ${resource.uri}, ${resource.blob.length} base64 chars]`);
			}
			continue;
		}
		if (item.type === 'resource_link') {
			const description = item.description ? ` - ${item.description}` : '';
			parts.push(`[Resource link: ${item.name} (${item.uri})${description}]`);
			continue;
		}
		parts.push(JSON.stringify(item));
	}

	return parts.filter(Boolean).join('\n\n') || '(MCP tool returned no content)';
}
