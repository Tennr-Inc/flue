---
title: MCP
description: Connect agents to remote MCP servers and mount their tools.
lastReviewedAt: 2026-09-25
---

[MCP](https://modelcontextprotocol.io) (Model Context Protocol) is an open standard for connecting AI agents to external services. Instead of writing a [tool](/docs/guide/tools/) for every Linear, Notion, or GitHub action your agent needs, connect to an MCP server and your agent gets access to its tools, remotely.

This guide covers how you can use `useMcpConnection()` to connect to a server, manage authentication, and configure your connection.

## Connect to an MCP server

Connect your agent to an MCP server by calling `useMcpConnection()` within your agent:

```ts title="src/agents/project-assistant.ts"
'use agent';
import { useMcpConnection, useModel } from '@flue/runtime';

export function ProjectAssistant() {
  useModel('anthropic/claude-sonnet-4-6');
  useMcpConnection({
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    auth: process.env.LINEAR_API_KEY,
  });
  return 'Manage Linear issues and projects for the team.';
}
```

When the agent runs, Flue connects to the server, discovers its tools, and adds them to the agent's tool set. The tools are named `mcp__<server>__<tool>` (here, `mcp__linear__create_issue`) to avoid collisions with your own tools, and the model calls them like any other tool.

How connections behave:

- Flue connects when the agent starts working on a message and reuses the connection while the instance stays live. You don't open or close connections yourself.
- If a server can't be reached, the run fails with an error and the next message retries. Set `optional: true` on the definition to run without that server's tools instead; the model is told they are unavailable.
- The declaration may be conditional, like a tool mount: an agent can gain or lose a server based on its state, and the model is told about the change.

See the [`useMcpConnection` reference](/docs/reference/agent-hooks-api/#usemcpconnection) for more details on behavior.

## Authenticate with an MCP server

Many hosted MCP servers expect a `Bearer` token, following the [MCP authorization model](https://modelcontextprotocol.io/docs/tutorials/security/authorization) (standard OAuth 2.1). Use the `auth` property to supply it.

The simplest way to provide authorization is via string value. Use this for static authorization, like a service-wide API token:

```ts title="src/agents/project-assistant.ts"
'use agent';
import { useMcpConnection, useModel } from '@flue/runtime';

export function ProjectAssistant() {
  useModel('anthropic/claude-sonnet-4-6');
  useMcpConnection({
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    auth: process.env.LINEAR_API_KEY,
  });
  return 'Manage Linear issues and projects for the team.';
}
```

Some MCP servers expect a dynamic per-user or per-session authorization token. When you need dynamic authorization, you may pass a function to `auth` instead of a string. The function is resolved on every request, so tokens can rotate and revoke and leave you with full control:

```ts
export function Assistant() {
  const { userId } = useInitialData<{ userId: string }>();

  useMcpConnection({
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    auth: () => tokenStore.get(userId, 'linear'),
  });

  return 'Help this user manage their Linear issues.';
}
```

Flue never stores or manages your tokens. It is your responsibility to own any OAuth flow, token storage, and refresh token logic.

To attach a server after the user authorizes it mid-conversation, declare the connection conditionally on a persistent flag:

```ts
const [linearReady, setLinearReady] = usePersistentState('linear-ready', false);

if (linearReady) {
  useMcpConnection({
    name: 'linear',
    url: LINEAR_MCP_URL,
    auth: () => tokenStore.get(userId, 'linear'),
  });
}

useAgentStart(async () => {
  if (!linearReady && (await tokenStore.has(userId, 'linear'))) setLinearReady(true);
});
```

When your OAuth flow completes and the flag flips, the agent has the server's tools from its next message on. If several agents need to share one user's authorization, put the integration in your application: an application-owned integration service can itself be an MCP server that agents connect to.

## Specifying tools

Servers commonly expose dozens of tools, and every mounted tool takes up model context. The `tools` allowlist mounts only the tools you list:

```ts
useMcpConnection({
  name: 'linear',
  url: 'https://mcp.linear.app/mcp',
  auth: process.env.LINEAR_API_KEY,
  tools: ['create_issue', 'search_issues', 'get_issue'],
});
```

If the allowlist names a tool the server doesn't expose, the connection fails with an error.

## Require approval for MCP tools

Set `approval` to park calls to a server's tools until a human or policy decides, the same way an [approval-gated tool](/docs/guide/tools/#require-approval-before-a-tool-runs) does:

```ts
useMcpConnection({
  name: 'linear',
  url: 'https://mcp.linear.app/mcp',
  auth: process.env.LINEAR_API_KEY,
  tools: ['search_issues', 'create_issue', 'delete_issue'],
  approval: {
    required: true,
    tools: ['create_issue', 'delete_issue'],
    expiresInMs: 24 * 60 * 60 * 1000,
  },
});
```

- `approval.tools` lists the server's own tool names to gate. Omit it to gate every mounted tool, including tools the server adds later. Naming a tool that isn't mounted fails the connection.
- The proposal records the model's arguments after they pass the tool's input schema. The approver decides through the same route, SDK method, and `ToolApprovalProvider` as any other approval.
- Flue derives each gated tool's approval version from its input schema. If the server changes that schema while an approval is pending, the approved call fails with a tool error instead of running. Behavior the server changes behind an unchanged schema is not detected.
- The proposal's `presentation.title` is the server's tool title. It is server-supplied text, so an approval UI should show the tool name and arguments, not only the title.
- An approved call interrupted before its outcome is recorded is reported as unknown and not retried, like any approved tool without `durable: true`.
- Approval-gated execution currently requires the Cloudflare target.
- Connection definitions are read at first connect, so a changed `approval` takes effect when the instance next connects — after a deploy or an instance restart.

## Reusing an MCP server definition

`defineMcpConnection(...)` validates an MCP connection object so you can define it once and then reuse it from any agent:

```ts title="src/connections/linear.ts"
import { defineMcpConnection } from '@flue/runtime';

export const linear = defineMcpConnection({
  name: 'linear',
  url: 'https://mcp.linear.app/mcp',
  auth: process.env.LINEAR_API_KEY,
});
```

```ts
import { linear } from '../connections/linear.ts';
useMcpConnection(linear);
useMcpConnection({ ...linear, tools: ['search_issues'] }); // override fields per mount
```

## Security

An MCP server you connect to can influence your agent: its tool descriptions enter the prompt, and its tool results enter the conversation. Treat a server you don't control like any other third-party dependency, and consider using the `tools` allowlist to limit the surface area of your exposure and `approval` to put a person in front of tools with side effects.

## Advanced: Making a direct MCP server connection

`createMcpConnection(definition)` is the lower-level function underneath the hook. It connects, discovers the server's tools, and returns them as [`ToolDefinition`](/docs/reference/agent-api/#definetool) values, so trusted application code can filter or wrap them before mounting with `useTool`:

```ts
const linear = await createMcpConnection({ name: 'linear', url: LINEAR_MCP_URL, auth: TOKEN });

export function ProjectAssistant() {
  useModel('anthropic/claude-sonnet-4-6');
  for (const tool of linear.tools) useTool(tool);
  return 'Manage Linear issues and projects for the team.';
}
```

Each adapted definition preserves the server's MCP `annotations`, so trusted application code can inspect `tool.annotations?.readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` before mounting or wrapping it. These are server-supplied hints, not a security boundary; only use them for approval decisions when you trust the server. To gate calls by tool name instead, set [`approval`](#require-approval-for-mcp-tools) on the definition.

This can also be helpful inside of a Node.js script, if you're ever using the Node.js JavaScript API directly — see [Standalone scripts](/docs/guide/building-agents/#standalone-scripts).

## Next steps

- [Tools](/docs/guide/tools/) — how tools work in Flue, including guards and conditional mounting.
- [`useMcpConnection` reference](/docs/reference/agent-hooks-api/#usemcpconnection) — the hook's render contract and semantics.
- [`McpConnectionDefinition`](/docs/reference/agent-api/#mcpconnectiondefinition) and [`createMcpConnection`](/docs/reference/agent-api/#createmcpconnection) — the definition fields and the adaptation contract.
