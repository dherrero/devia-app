# Auto-continue after the usage limit

Status: implemented (Claude Code only)
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

When Claude Code hits the account's usage limit, Devia waits for the window to reset and continues the same session by itself.

## Does

- Switch: Settings → Execution → Claude → "Auto-continue sessions" (`config.autoContinueSessions[agentId]`, default off; only `claude` produces the event).
- Detection: the Claude decoder (`src/main/features/agents/claude/decoder.ts`, helper `limit-text.ts`) turns a `rate_limit_event` with `status: 'rejected'` (or the synthetic assistant message `error: "rate_limit"` / `apiError: "usage_limit_reached"`, or as last resort the error `result` text "resets 11:30am (Europe/Madrid)") into an `AgentEvent` `rate_limit` with `resetsAt` in epoch ms; `allowed` is silent, `allowed_warning` becomes `warning`; reported once per run. The run's error `result` is classified `transient`.
- `RunInstructionUseCase` remembers a rejection and calls `handlers.onRateLimited` right before `onProcessEnd`; `claude.ipc.ts` asks `AutoResumeScheduler` (`src/main/features/claude-runner/application/auto-resume-scheduler.ts`) to continue at `resetsAt` + 30 s (`DEFAULT_MARGIN_MS`) via `submitInstruction` with the SAME mode/origin/runKey/sessionId and the fixed prompt "Continue where you left off." (native resume carries the context).
- Deadlines are polled against the wall clock every 15 s (`DEFAULT_POLL_MS`) and re-checked on `powerMonitor('resume')`, because a `setTimeout` does not advance while the machine sleeps. Waits up to 8 days (`DEFAULT_MAX_WAIT_MS`) are scheduled, so the weekly window is resumed too.
- The queue is NOT dispatched while a resume is pending (parked items would hit the same limit).
- A user message, Stop, session reset, agent switch, or turning the switch off cancels it (re-checked when it fires).
- Renderer: `ds-auto-resume-banner` (above the queue panel) fed by `autoresume:scheduled` / `autoresume:cancelled`, with a Cancel button (IPC `autoresume:cancel`); shows the date when the reset is not today.

- Error card (S-54): when a run ends on the limit, the chat card says when it resumes (`resetsAt`) and, if the switch is off, offers "Turn on auto-continue". The card only READS `resetsAt` and the switch (`claude.explain.ts`); scheduling is unchanged and pinned by the tests below.

## Does NOT

- Does NOT survive closing Devia: a pending resume is in memory only; the app must stay open meanwhile.
- Does NOT work for other agents (no `rate_limit` event from their parsers).
- Does NOT cap consecutive resumes: S-45 removed the old "at most 3 in a row" rule (`noteCleanRun` no longer exists in the scheduler). AGENTS.md before this docs change still described the cap.
- The exact stdout stream lines of `-p` mode for the limit have no recorded fixture; the shapes come from session transcripts on disk (Claude Code 2.1.302), which is why all three sources are handled. UNVERIFIED against a live limit hit.

## Entry points

- `src/main/features/claude-runner/application/auto-resume-scheduler.ts:AutoResumeScheduler` — scheduling
- `src/main/features/claude-runner/ipc/claude.ipc.ts` — wiring, `autoresume:cancel`, toggle-off cancellation
- `src/main/features/agents/claude/decoder.ts` — `rate_limit` event
- `src/main/features/agents/claude/limit-text.ts` — parses "resets 11:30am (Europe/Madrid)"
- `src/renderer/app/features/chat/auto-resume/` — banner

## IPC / MCP surface

- IPC `autoresume:cancel`; events `autoresume:scheduled`, `autoresume:cancelled`.

## Persistence

None (memory only).

## Config

`autoContinueSessions: Record<agentId, boolean>`.

## Gotchas

- Fires only if the active agent is still the one that was rate limited and the switch is still on.
- Telegram-origin runs resume with the same origin.

## Tests

- `src/main/features/claude-runner/application/run-instruction.use-case.test.ts` ("usage limit reporting": `onRateLimited` with `resetsAt` before `onProcessEnd`), `src/main/features/claude-runner/ipc/claude.ipc.test.ts` (resume still scheduled while the error is explained), `src/main/features/claude-runner/application/auto-resume-scheduler.test.ts`, `src/main/features/agents/claude/decoder.rate-limit.test.ts`, `src/main/features/agents/claude/limit-text.test.ts`.

## Related

- [claude-runner.md](claude-runner.md), [agents.md](agents.md), [queue.md](queue.md)
