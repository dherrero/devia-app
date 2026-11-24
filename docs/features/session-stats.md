# Session stats (context, cost, tokens, compactions)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Per-session rollup of agent, model, context fill, cost and compactions, shown in the footer token meter, the sessions list and `/status` over Telegram.

## Does

- `SessionStats` (`src/shared/domain/session-stats.ts`): `agentId` and `model` of the last turn, `contextWindow`, `contextTokens` (point-in-time fill = `inputTokens + cachedInputTokens` of the LAST request, drops after a compaction), cumulative `costUsd` (0 where the CLI reports none), optional `costByModel`, `turnCount`, `compactions[]` (`CompactionRecord`: `at`, `trigger`, `preTokens`, `postTokens`), `updatedAt`.
- `buildSessionStats` (same file) computes the rollup from persisted messages; `SaveChatUseCase` stamps it on every save; `PersistedSession.stats` carries it and the sessions list carries the compact `SessionStatsSummary`.
- `LoadActiveStatsUseCase` (`src/main/features/sessions/application/load-active-stats.use-case.ts`) serves the active session's rollup; `AggregateStatsUseCase` sums every session's rollup into `SessionStatsAggregate` (grand total, per-model, session count) reading only rollups, never message arrays.
- Context window: from the CLI when reported (Claude `modelUsage[<run model>]`), else a static table in `src/shared/domain/context-budget.ts:getModelContextLength` (`claude-default` = 200 000).
- Footer: `src/renderer/app/layout/statusbar/components/token-meter/token-meter.component.ts`. Compaction alerts use `contextAlertBand` hysteresis (`CONTEXT_ALERT_REARM_RATIO` = 0.7).
- Every usage field survives persistence through `PersistedAgentEvent` (`src/shared/domain/persisted-agent-event.ts`), so reload keeps `cachedInputTokens` and `contextWindow`.

## Does NOT

- Does NOT report cost for agents whose CLI gives none (shows 0).
- Does NOT send stats anywhere: the aggregate is local ("would later be pushed to a SaaS backend", per the code comment; no such push exists).
- Does NOT show plan-usage windows (5 h / weekly limits) or per-account usage; only per-session context and cost.
- Claude's `result.usage` top-level counters are summed over every request in the run (≈9× the context on a tool-heavy turn) and are NOT used for context fill.

## Entry points

- `src/shared/domain/session-stats.ts:buildSessionStats` — rollup builder
- `src/main/features/sessions/application/aggregate-stats.use-case.ts:AggregateStatsUseCase` — Devia-wide total
- `src/main/features/sessions/application/load-active-stats.use-case.ts:LoadActiveStatsUseCase` — active session
- `src/shared/domain/context-budget.ts:getModelContextLength` — window table
- `src/renderer/app/layout/statusbar/components/token-meter/token-meter.component.ts` — footer meter

## IPC / MCP surface

- IPC `sessions:active-stats`, `stats:aggregate`, `sessions:list`.

## Persistence

`stats` field of `~/.devia-app/sessions/<project>/session-<uuid>.json`.

## Config

None.

## Gotchas

- Pre-fix sessions showed a context bar 5× too high after reload (the static 200k table was used) because `cachedInputTokens`/`contextWindow` were dropped on persist; keep new usage fields in `PersistedAgentEvent`.
- Every parser must emit `inputTokens` EXCLUDING cache (Codex's `cached_input_tokens` is a subset of `input_tokens` and is subtracted).

## Tests

- `src/shared/domain/session-stats.test.ts`, `src/shared/domain/context-budget.test.ts`, `src/renderer/app/layout/statusbar/components/token-meter/token-meter.component.spec.ts`.

## Related

- [sessions.md](sessions.md), [context-recovery.md](context-recovery.md), [context-compression.md](context-compression.md), [auto-continue.md](auto-continue.md)
