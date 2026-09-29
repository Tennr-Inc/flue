---
'@flue/runtime': minor
---

Add an optional `beforeModelCall` callback to `useModel()` for choosing reasoning effort before each root-agent model call. The selected effort is persisted so interrupted submissions reuse the same choice on recovery.
