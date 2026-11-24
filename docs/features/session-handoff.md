# Cross-agent session handoff

Status: implemented (desktop only)
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

When the user continues a session with a DIFFERENT CLI agent than the one that owns it, Devia hands the context over automatically so the new agent does not start blind.

## Does

- Trigger (in `RunInstructionUseCase`): the record's `agentSessionAgentId` exists, differs from `def.id`, and the active session has messages.
- Builds the brief with `buildHandoffBrief()` (`src/shared/domain/handoff.ts`, pure): goal + touched files + verbatim last 4 turns, 6000-char cap trimming the tail first. Injected into THIS run's system prompt (never via memory recall, so the first turn is guaranteed).
- Records it in memory as a `kind: 'handoff'` session entry, appended standalone (`upsertSession` skips `kind: 'handoff'` so later run summaries never overwrite it).
- Emits `session:handoff` before `process:start`; the renderer persists a `ChatMessage` with `kind: 'handoff'` + `handoff: { fromAgentId, toAgentId }` and renders `HandoffDividerComponent` (collapsible summary).
- Idempotent without flags: the new run's `session_started` overwrites the owner. A handoff failure never aborts the run.
- LLM-enriched summary (F2.3): `HandoffSummariser` precomputes a summary in the background when a handoff becomes foreseeable (agent switch with foreign-owned sessions, or switching/adopting a foreign-owned session); consumed synchronously, TTL 10 min, one-shot ([context-compression.md](context-compression.md)).
- "Ask previous agent for a summary" (F3.4): a toast action sends `buildHandoffRequestPrompt()` to the previous agent with `agentIdOverride` (the run executes under that agent, resuming its native session, skipping passive memory capture); the handoff then prefers that fresh summary (< 15 min) over the compressed one.
- For `continuity: 'replay'` agents (Gemini), the runner also re-seeds the transcript via `buildConversationReplay()` (`src/shared/domain/conversation-replay.ts`, budget `replayBudgetChars`), skipped when a handoff brief already carries the tail or on the first turn.
- Memory records stamp `agentId` (in-process sinks pass `def.id`; the out-of-process `devia-memory` server reads `DEVIA_ACTIVE_AGENT_ID`).

## Does NOT

- Does NOT hand off over Telegram specially: it rides the same run path, but the toast/action UI is desktop-only.
- Does NOT carry tool results or files beyond the brief: the new agent sees a summary and the last four turns, not the full transcript.
- The LLM summary is NOT produced unless an auxiliary client is available (Claude with `ANTHROPIC_API_KEY` in the environment); otherwise the deterministic brief is used.
- Does NOT switch agents mid-run.

## Entry points

- `src/shared/domain/handoff.ts:buildHandoffBrief` — brief builder
- `src/main/features/claude-runner/application/run-instruction.use-case.ts:RunInstructionUseCase` — trigger and injection
- `src/main/features/context-compression/application/handoff-summariser.ts:HandoffSummariser` — background summary
- `src/main/features/sessions/application/switch-session.use-case.ts:SwitchSessionUseCase` — prepares handoff on switch
- `src/renderer/app/features/chat/chat-panel/utils/agent-handoff.util.ts` — `detectPendingHandoff`
- `src/shared/domain/conversation-replay.ts:buildConversationReplay` — replay for Gemini

## IPC / MCP surface

- Event `session:handoff` (`SessionHandoffEvent`).

## Persistence

Handoff divider message in the session file; handoff entry in memory (`kind: 'handoff'`).

## Config

`config.memory.enabled` (memory record). None specific otherwise.

## Gotchas

- Session identity (`agentId`, `agentSessionId`) is restored by `SwitchSession`/`AdoptSession` into the registry pointer; with no identity the pointer is null → fresh native session + memory pre-injection.
- Override runs skip passive memory capture so the auto run-summary does not overwrite the rich summary.

## Tests

- `src/shared/domain/handoff.test.ts`, `src/shared/domain/conversation-replay.test.ts`, run-instruction handoff cases in `run-instruction.use-case.test.ts`.

## Related

- [sessions.md](sessions.md), [memory.md](memory.md), [context-compression.md](context-compression.md), [../multisesion/01-session-identity.md](../multisesion/01-session-identity.md)
