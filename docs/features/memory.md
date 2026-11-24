# Memory (`devia-memory`)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Devia's own persistent memory (observations, session summaries, prompts) for every agent, served as an MCP server and injected into prompts.

## Does

- Storage: JSON (`MemoryStore`, `src/main/features/memory/infrastructure/memory-store.ts`): personal scope `~/.devia-app/memory-global.json`, project scope `~/.devia-app/projects/<key>/memory.json`; atomic temp+rename, in-memory read cache, defensive parser; lexical search (token overlap, title boosted ×3). Every read-modify-write starts from disk (`loadFresh`), never the cache, because the out-of-process MCP server writes the same files.
- `devia-memory` MCP server (`src/main/features/memory/mcp-server/server.ts`, stdio JSON-RPC, no SDK, spawned with `process.execPath` + `ELECTRON_RUN_AS_NODE=1`): tools `mem_save`, `mem_search`, `mem_context`, `mem_session_summary`, `mem_get_observation`, `mem_save_prompt`, `mem_current_project`.
- Optional semantic re-ranking of `mem_search` (`mcp-server/semantic-rerank.ts`): lexical candidate pool of 40 re-ordered by embedding cosine similarity using `@xenova/transformers` (all-MiniLM), lazy-loaded; any failure leaves the lexical order untouched.
- System prompt: `memory-protocol.ts` is appended only when `config.memory.enabled` (default true) and tells the agent the `mem_*` tools exist; first turn injects recalled context (`memory-context-hint.ts`, budget `memoryHintBudgetChars`); passive capture at run end saves prompts and an auto session summary (`memory-capture.ts`), where an agent-authored `mem_session_summary` is never replaced by the auto one.
- Project identity = BASE checkout, never the run cwd: memory and kanban `--project` use `projectCheckout`; a startup migration (`worktree-memory-migration.ts`) folds orphan worktree-keyed stores back into their base project.
- Records stamp `agentId` (in-process sinks pass `def.id`; the MCP server reads `DEVIA_ACTIVE_AGENT_ID`).
- Engram integration: `DetectEngramUseCase` (binary on PATH and `${ENGRAM_DATA_DIR:-~/.engram}/engram.db`), `ImportEngramUseCase` (`engram export` into the personal store, preserving the original `project` tag, skipping soft-deleted and already-imported by `syncId`, sets `config.memory.engramImported`). `config.memory.blockEngram` (default true) makes Claude run with `--strict-mcp-config`.
- Settings → Memory panel lists observations and SESSION summaries (newest first, capped at 10), project/personal toggle, forget, clear, pin.
- Startup toast (once per launch) when engram is installed, memory is on and engram is not blocked.

## Does NOT

- Does NOT use embeddings for primary search: only the optional re-rank over the lexical pool; no vector index.
- Does NOT enforce engram blocking for non-Claude agents (no per-run MCP flag): the Settings UI warns.
- Under an enterprise-managed Claude MCP config (`managed-mcp.json`), Devia's servers (including `devia-memory`) are NOT injected and neither MCP flag is passed.
- Does NOT sync memory across machines.
- Does NOT migrate orphan `kanban.json` files created by the same worktree bug (merging board ids is unsafe).

## Entry points

- `src/main/features/memory/index.ts:buildMemoryFeature` — wiring
- `src/main/features/memory/infrastructure/memory-store.ts:MemoryStore`
- `src/main/features/memory/application/memory.use-case.ts:MemoryUseCase`
- `src/main/features/memory/mcp-server/memory-tools.ts` — tool implementations
- `src/main/features/memory/mcp-server/memory-mcp-injector.ts` — server config
- `src/main/features/memory/mcp-server/semantic-rerank.ts` — optional re-rank
- `src/main/features/memory/application/detect-engram.use-case.ts:DetectEngramUseCase`
- `src/main/features/memory/application/import-engram.use-case.ts:ImportEngramUseCase`
- `src/main/features/memory/ipc/memory.ipc.ts`
- `src/shared/domain/memory.ts` — types

## IPC / MCP surface

- MCP tools above; IPC `memory:detect-engram`, `memory:import-engram`, `memory:search`, `memory:list`, `memory:list-sessions`, `memory:set-pinned`, `memory:forget`, `memory:clear`.

## Persistence

`~/.devia-app/memory-global.json`, `~/.devia-app/projects/<key>/memory.json` (migrated originals renamed `memory.json.migrated`).

## Config

`config.memory`: `{ enabled, blockEngram, engramImported, engramImportedAt? }` (defaults enabled true, blockEngram true).

## Gotchas

- Cross-process cache invalidation: every read/mutation IPC handler in `memory.ipc.ts` calls `store.invalidate(scope, projectPath)` first, else Settings serves a pre-run snapshot and the agent's `mem_save` never appears.
- Permission is written to agent config like kanban: Claude via `--mcp-config` + `grantClaudeMcpAccess`; others through `injectMemoryMcp` → `McpSyncWriter`.
- The source comments reference `docs/memory/*.md` files that were never committed; this page is the record.
- `DEVIA_ASSUME_ENTERPRISE_MCP=1|0` overrides enterprise detection.

## Tests

`src/main/features/memory/**/*.test.ts` (store, tools, semantic rerank, migration, engram).

## Related

[session-handoff.md](session-handoff.md), [context-recovery.md](context-recovery.md), [mcp.md](mcp.md), [../reference/mcp-servers.md](../reference/mcp-servers.md)
