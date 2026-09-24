---
'@flue/runtime': minor
'@flue/vite': minor
---

Add an optional `agentResolver` module for Cloudflare deployments. Its default-exported `CloudflareAgentResolver` selects an agent implementation per durable instance for admission, execution, and recovery, with per-instance caching and no fallback on resolution errors. The selected implementation supplies its own initial-data schema and durability policy while continuing to use the deployed Flue runtime. Node builds reject this Cloudflare-only configuration; `flue run` ignores it and continues to execute the explicitly named local agent module.
