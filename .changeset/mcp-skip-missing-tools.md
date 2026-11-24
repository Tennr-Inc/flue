---
'@flue/runtime': minor
---

Add `missingTools` and `onToolDiscovery` to `McpConnectionDefinition`. With `missingTools: 'skip'`, a `tools` allowlist entry the server does not list (or that requires task-based execution) is left unmounted instead of failing the connection; its `approval.tools` and `approval.escalations` entries are dropped, so an approval list that named only skipped tools gates nothing rather than every mounted tool. Each connect that skips tools logs one warning event, and the model is told which allowlisted tools are absent. The connection still fails when no allowlisted tool can mount. `onToolDiscovery` receives every tool the server lists (`McpToolDiscovery`, exported with `McpDiscoveredTool`) once per actual connect, before the allowlist is applied; a throw is logged and ignored. The default `'error'` keeps today's behavior.
