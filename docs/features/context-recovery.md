# Context recovery

Status: partial
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

When a CLI agent compacts its own context mid-session it forgets what Devia injected (memory). This feature records the compaction and makes the NEXT run re-inject Devia's memory context once.

## Does

- `MemoryReinjectionTracker` (`src/main/features/context-recovery/application/memory-reinjection-tracker.ts`): in-memory set of project paths owing a re-injection (`markCompacted`, `isPending`, `consume`, `clear`).
- `buildContextRecoveryFeature` (`src/main/features/context-recovery/index.ts`) exposes `markContextCompacted(projectPath)` and `consumeMemoryReinjection(projectPath)` to the runner.
- Detection comes from per-agent parsers emitting the shared `{ type: 'context_compacted' }` `AgentEvent`. Wired for Claude (stream-json system event `subtype: "compact_boundary"`, mapped in `src/main/features/agents/claude/decoder.ts`) and for pi (`compaction_end` in `src/main/features/agents/pi/rpc-driver.ts`).
- With a per-turn-context agent (Claude), a compaction also forces the turn-context block to be re-sent ([agents.md](agents.md)).

## Does NOT

- Does NOT detect compaction for Codex, Gemini, OpenCode, Cursor, Copilot: no verified in-stream signal (Codex's parser comment says so; no `context_compacted` is emitted by those parsers or by OpenCode/ACP). No token-threshold fallback exists.
- Does NOT persist across restarts: state is in memory; a compaction never followed by another run in the same app lifetime needs no recovery, and a new session re-injects through the first-turn path anyway.
- Does NOT inject into a running process; recovery is deferred to the next run.

## Entry points

- `src/main/features/context-recovery/index.ts:buildContextRecoveryFeature` — feature factory
- `src/main/features/context-recovery/application/memory-reinjection-tracker.ts:MemoryReinjectionTracker` — state
- `src/main/features/claude-runner/application/run-instruction.use-case.ts:RunInstructionUseCase` — consumes the flag
- `src/main/features/agents/claude/decoder.ts` — emits `context_compacted`
- `src/main/features/agents/pi/rpc-driver.ts` — emits `context_compacted` on `compaction_end`

## IPC / MCP surface

None.

## Persistence

None (in memory).

## Config

Depends on `config.memory.enabled` (re-injection delivers memory context; see [memory.md](memory.md)).

## Gotchas

- Source comments point to `docs/memory/03-*.md`, which does not exist in this repository (never committed). The facts above are the current truth.

## Tests

- `src/main/features/context-recovery/` has unit tests for the tracker; the Claude decoder tests cover the event mapping.

## Related

- [memory.md](memory.md), [agents.md](agents.md), [session-stats.md](session-stats.md)
