---
'@flue/runtime': minor
'@flue/sdk': minor
---

Support text file attachments on user messages. `DeliveredAttachment` gains a `file` variant — `{ type: 'file', data, mimeType, filename? }` with `mimeType` one of `text/plain`, `text/csv`, `application/json`, `application/x-ndjson`, or `application/har+json` — accepted on `dispatch()`, the `init()` handle, and direct HTTP prompts. The runtime stores a file's bytes like any attachment but never sends them to the model: the model context carries only a `<file id filename mimeType size />` entry in the message's attachment manifest. The agent reads the bytes from `useDelivery()` and decides where they go, for example writing them to the sandbox from a `useAgentStart` hook. Files forwarded to a subagent by attachment id arrive the same way. An `image` attachment whose `mimeType` is a file type is now rejected with `invalid_request`, because stored attachments keep only their MIME type. Image and document behavior is otherwise unchanged. Both packages export `DeliveredFileAttachment`.
