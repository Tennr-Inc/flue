---
'@flue/runtime': minor
---

Rename `useModel()`'s `beforeModelCall` option to `beforeModelTurns` (and its `BeforeModelCall*` types to `BeforeModelTurns*`), and run it once per delivered message instead of before every root-agent model call. Calls after tool results now reuse the effort chosen for the current delivery, so a tool loop keeps one request-level effort and its prompt cache. A joined delivery or a signal appended by a start or finish hook selects again; framework narration signals do not. Agents that pass `beforeModelCall` now fail at render with an unknown-field error.
