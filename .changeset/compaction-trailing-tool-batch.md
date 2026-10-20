---
'@flue/runtime': patch
---

Compact sessions whose newest tool-result batch alone exceeds `keepRecentTokens`. The cut point now keeps that batch together with the assistant message that requested it and summarizes the older history. Before, no cut point qualified, so compaction did nothing and the next model call overflowed again.
