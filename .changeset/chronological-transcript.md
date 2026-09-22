---
'@flue/runtime': minor
'@flue/sdk': minor
---

Add an opt-in chronological transcript to SDK `history()` and `observe()` with `transcript: 'chronological'`. Each assistant step retains its identity and position around user steering, consistently across history, live updates, and reconnects. The default combined response view is unchanged. Tool results, anchored data parts, response metadata, and submission reply reads retain their semantics.
