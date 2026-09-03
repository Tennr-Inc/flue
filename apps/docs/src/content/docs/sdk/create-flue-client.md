---
title: createFlueClient(...)
description: Constructing a Flue Agent SDK client — URL semantics, fetch override, headers, and token.
lastReviewedAt: 2026-07-21
---

```ts
import { createFlueClient } from '@flue/sdk';

const conversation = createFlueClient({
  url: 'https://example.com/agents/triage/ticket-42',
  token: process.env.FLUE_TOKEN,
});
```

## `createFlueClient()`

```ts
function createFlueClient(options: CreateFlueClientOptions): FlueClient;
```

Creates a client for one agent conversation of a deployed Flue application. The framework does not know where an application mounts its agents — the application's [route map](/docs/guide/routing/) (`app.ts`) does — so a client addresses exactly one conversation by URL: wherever the agent's router (`createAgentRouter(...)`) is mounted, plus a caller-chosen conversation id. Starting a new conversation is constructing a client with a fresh id appended to the mount URL — ids are caller-chosen, and the conversation is created by the first admitted send. There is no deployment-wide client and no name/id addressing.

Construction is synchronous and makes no network requests: the URL is resolved and the [`FlueClient`](/docs/sdk/flue-client/) is returned. Nothing verifies that the URL reaches a mounted agent or that the conversation exists — the first request does, rejecting with [`FlueApiError`](/docs/sdk/errors/#flueapierror) on a non-2xx response. The one construction-time failure is a relative `url` outside a browser, which throws a `TypeError`.

## Resolving tool approvals

The client also resolves durable approval proposals observed through `history()` or `observe()`:

```ts
const approval = await conversation.resolveToolApproval('approval_01HZX...', {
  status: 'approved',
  reason: 'Operator confirmed the action.',
});
```

This sends `POST <url>/tool-approvals/<proposalId>` with the JSON body `{ status, reason? }` and returns the durable approval row. `status` is one of `approved`, `rejected`, `expired`, `canceled`, or `aborted`; `reason` is optional. `createAgentRouter(...)` mounts this endpoint automatically, so a host application needs no extra ToT route or approval runtime. The same client headers and token are sent, allowing the host's mount middleware to authenticate and authorize the decision. Durable approval state currently requires Cloudflare Durable Object SQLite; `ToolApprovalProvider` is optional when a server also wants notification delivery.

## `CreateFlueClientOptions`

```ts
type CreateFlueClientOptions = HttpClientOptions;

interface HttpClientOptions {
  url: string;
  fetch?: typeof fetch;
  headers?: RequestHeaders;
  token?: string;
}
```

`CreateFlueClientOptions` is an alias of `HttpClientOptions`; both names are exported.

| Field     | Description                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`     | URL of one agent conversation: the URL where the agent's routes are mounted plus the conversation id (`https://host/agents/triage/ticket-42`). Trailing slashes are stripped. In a browser, a relative URL (`/api/agents/triage/ticket-42`) resolves against `location.origin`; outside a browser, a relative URL throws `TypeError: relative url requires a browser; pass an absolute URL`. |
| `fetch`   | HTTP implementation used for every request the client makes, including the stream reads behind `wait()` and `observe()`. Defaults to the global `fetch` bound to `globalThis` (so the browser's "Illegal invocation" receiver check cannot trip). A caller-supplied function is used as-is — bind it yourself if it is a method of another object.                                           |
| `headers` | Headers merged into every request. Merged after the `token`-derived header, so a `headers` entry named `authorization` wins over `token`.                                                                                                                                                                                                                                                    |
| `token`   | Bearer token, sent as `authorization: Bearer <token>` on every request.                                                                                                                                                                                                                                                                                                                      |

The options deliberately carry no retry or timeout configuration. Each JSON request (`send()`, `abort()`, `history()`, `resolveToolApproval()`) is a single fetch cancelled per call via `AbortSignal`; the reconnecting stream reads take `backoffOptions` per call on [`wait()`](/docs/sdk/flue-client/#wait) and [`observe()`](/docs/sdk/flue-client/#observe).

### Service bindings and other custom transports

Because every request — streaming reads included — travels through the `fetch` option, the client works over any fetch-shaped transport. On Cloudflare, point it at a [service binding](/docs/guide/cloudflare-target/#calling-a-private-agent-over-a-service-binding) to reach a private Worker; the `url` host is never dialed, so any placeholder origin works as long as the URL is absolute:

```ts
const conversation = createFlueClient({
  url: 'https://agent.internal/agents/support/ticket-42',
  fetch: (input, init) => env.AGENT_APP.fetch(new Request(input, init)),
});
```

The same override injects a test transport: hand `fetch` a function that returns canned `Response` objects and no network is touched.

## `RequestHeaders`

```ts
type RequestHeaders =
  Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
```

Static headers, or a function that resolves headers for each HTTP request. The function form (sync or async) is re-evaluated once per JSON request and once per stream connection and reconnection, so an async factory can refresh a short-lived token and every retry picks up the fresh value.

Headers apply only to requests the client itself makes. [`attachmentUrl()`](/docs/sdk/flue-client/#attachmenturl) returns a plain URL string; a request you make with it (an `<img>` load, a manual fetch) carries none of these headers.
