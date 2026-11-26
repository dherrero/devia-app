# Cross-agent workers

Status: partial
Verified: 1ea6c92f5d3745338288023fc88cc0e6f265ea2d

## Purpose

Lets the agent that follows the Devia Method (the controller) hand an implementer or reviewer job of a kanban task to a different detected agent (S-56). The controller stays in charge of the loop; Devia provides the mechanics (resolution of the agent, waiting for the run, limits). Off by default: every worker is a full CLI run that spends that agent's own quota.

## Does

- Defines the roles of the method as `WorkerRole = 'implementer' | 'reviewer'` and the report contract `WorkerStatus` (`DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, `BLOCKED`) in `src/shared/domain/cross-agent.ts`; `parseWorkerReport` turns a worker's final text into a report and never throws (no `STATUS:` line = `BLOCKED`); `renderWorkerReport` truncates the tail at 8000 characters and says so.
- Builds the role question (`buildAssignQuestion`: `a` is the main agent, `b…` the rest) and parses the reply `1. b  2. c` in code, not with an LLM (`parseAssignReply`): no partial map, only the invalid roles come back in `retryRoles`.
- Stores which agent runs each role per project: `ProjectRecord.roleAgents` (`state.json`), set by `SetRoleAgentsUseCase` (validates role and agent, `{}` clears).
- `resolveWorkerAgent` picks the agent: the project role mapping, else the effective agent of S-53. If that agent is not installed, not authenticated, unknown or not a CLI, it returns a failure with a message; it NEVER substitutes another agent. `listAvailableAgents` lists installed, authenticated CLI agents (an unknown auth state counts as usable).
- `createRunCompletion(gateway)` (`src/main/shared/run-completion.ts`) resolves `{status, finalText, error?}` when a run key ends (`done`, `failed`, `cancelled`, `timeout`; `onTimeout` lets the caller kill the run), ignoring events of other run ids, and releases its listener on every exit.
- `createWorkerRegistry` (`worker-registry.ts`): global semaphore (`maxConcurrent`, not per parent), per-turn cap, depth 1 (`isWorkerRunKey`), cascade `cancelParent`, per-worker `cancel`, and a circuit breaker (3 consecutive failures of a task). A cancelled worker keeps its slot until its caller calls `release()`.
- `SpawnWorkerUseCase.execute` launches one worker and returns its report: it resolves the agent, takes a slot, creates the worker's worktree from the CONTROLLER's HEAD (`ensureWorktree(ref, head)`; never the base checkout), starts the run through `RunGateway.submit` with `runKey`, `sessionId`, `isolate`, `agentIdOverride`, waits with `RunCompletion` (timeout stops the run) and parses the `STATUS:` report. The worker inherits the controller's mode and never raises it (a plan-mode controller launches nothing). Failures are `BLOCKED` reports, not exceptions.
- A worker run key (`devia-worker:<parent>:<task>:<n>`) gets only `todo` and `skill` from the UI tools policy (`isWorker`) and skips passive memory capture (it runs under `agentIdOverride`).
- The reviewer runs in the implementer's worktree and branch under its own run key, with the range `baseSha..HEAD` in its prompt; a fix round of the implementer reuses its run key and session. A reviewer that changes the worktree is flagged and nothing is integrated.
- `integrateWorker` runs `merge --ff-only` of the worker branch into the controller's checkout and, on success, removes the worktree and branch. When the controller moved on (`not_ff`) or uncommitted edits would be overwritten (`dirty`) nothing changes, the work stays on its branch and the report is downgraded to `DONE_WITH_CONCERNS` with the reason.
- Integration happens on an implementer `DONE`/`DONE_WITH_CONCERNS` when the project does not split the reviewer role, otherwise on a clean reviewer `DONE`.
- `devia_spawn_agent({ role, taskId })` (UI tool `spawn_agent`, blocking): offered only in apply/apply-yolo, to a run that is not a worker, when `crossAgent.enabled` is on, a runner exists and two or more agents are usable (`usableAgentCount`, a cached scan refreshed every 60 s and at startup). It is served by the main process (`RunInteraction.serveSpawnAgent`), not drawn as a card: it never arms the question kill timer, nudges the idle watchdog (`handle.keepAlive`) every 30 s while the worker runs, and the MCP server waits up to `defaultTimeoutSec + 120 s` (`--worker-timeout-ms`) instead of 5 minutes. Its answer is the worker's rendered report. It is also offered to remote (Telegram) runs: it needs no click.
- When the controller run ends (done or error) `cancelWorkers(parentKey)` cancels its workers.
- `buildCrossAgentFeature` (`index.ts`) composes the registry and the spawn use case from the run gateway, the detector, git and the worktree creator; it is wired in `composition-root.ts` and passed to the runner as `spawnWorker`, `usableAgentCount` and `cancelWorkers`. Limits are read from the config on every decision.
- `devia_assign_agents({ roles?, reassign? })` (UI tool `assign_agents`, blocking, plan mode only): offered when `crossAgent.enabled`, two or more agents are usable and the run is not a worker or remote. `AssignAgentsUseCase.prepare` answers straight from the project's saved map when it already covers the requested roles with usable agents (no card); otherwise it asks ONLY about what is missing or no longer usable (`reassign: true` asks about all). The desktop card (`ds-ui-assign-card`, one selector per role, first option = main agent) answers with the numbered text `1. b\n2. a`, which `finish` parses with `parseAssignReply` and saves through `SetRoleAgentsUseCase`. Choosing the main agent is saved as `main` so it is not asked again.
- Renderer surface: `worker:changed` (`{ parentKey, worker }`) on every state change (queued, running, done/failed/cancelled/timeout; rare, so not throttled) and the channels `worker:cancel` (one worker id), `worker:cancel-all` (a controller's run key) and `worker:list`, bridged as `onWorkerChanged`, `cancelWorker`, `cancelAllWorkers`, `listWorkers`. `ChatMessage.worker` carries a worker's `WorkerRun` in the thread; messages are persisted verbatim by the renderer's own save, so no second writer touches the session file.
- Worker bubbles (renderer): a worker's own run events reach the renderer keyed by its run key; `AppStateService` folds them into the controller's thread (`parseWorkerRunKey`): no `runningPaths` entry, no chat or error toast of its own. A finished worker message is HELD until the controller's own turn ends (so the thread keeps the order controller → workers) and shown by `workerMessagesFor(parentKey)` below the controller's live message; `worker:changed` patches the final state into the held or saved message. The bubble (`ds-assistant-turn`) uses the avatar letter `A` with no animation, a header `agent · role · task` + state/verdict + duration, a cancel button while queued/running (`cancelWorker`), and folds its body once finished (toggle to reopen).
- Session stats (`buildSessionStats`) add a worker message's COST to the session but never let it set the agent, model, context figure or turn count; the footer fallbacks skip worker messages too.
- Config `DeviaConfig.crossAgent` (`enabled` false, `maxConcurrent` 3 up to 8, `maxPerTurn` 8, `defaultTimeoutSec` 1800) with a block in Settings › Execution.

## Does NOT

- Does NOT have a Telegram flow (`devia_assign_agents` is not offered to remote runs yet): later tasks of S-56.
- Does NOT keep the implementer record across an app restart (in memory): a reviewer after a restart is told to dispatch the implementer again.
- Does NOT aggregate the workers' cost into the parent session stats yet.
- Does NOT use `explainError` for the failure messages: S-54 is not on `dev` yet, so they are plain strings.
- Does NOT pick an agent by strength: the mapping is the user's choice.

## Entry points

- `src/main/features/cross-agent/application/resolve-worker-agent.ts:resolveWorkerAgent`
- `src/main/features/cross-agent/application/set-role-agents.use-case.ts:SetRoleAgentsUseCase`
- `src/main/features/cross-agent/application/spawn-worker.use-case.ts:SpawnWorkerUseCase`
- `src/main/features/cross-agent/application/worker-registry.ts:createWorkerRegistry`
- `src/main/features/cross-agent/application/integrate-worker.ts:integrateWorker`
- `src/main/features/cross-agent/application/worker-prompt.ts:buildWorkerPrompt`
- `src/main/shared/run-completion.ts:createRunCompletion`
- `src/main/shared/ports/run-completion.port.ts:RunCompletion`
- `src/shared/domain/cross-agent.ts` (roles, report, assignment question/reply)
- `src/shared/domain/cross-agent-config.ts:normalizeCrossAgentConfig`
- `src/renderer/app/features/settings/settings-modal/components/settings-execution-section/` (cross-agent block)

## IPC / MCP surface

IPC: `worker:changed` (event), `worker:cancel`, `worker:cancel-all`, `worker:list` (`src/shared/contracts/ipc-channels.ts`).

MCP tools `devia_spawn_agent` and `devia_assign_agents` of the `devia-ui` server (`src/main/features/ui-tools/mcp-server/tool-registry.ts`). 

## Persistence

- `~/.devia-app/state.json` → `projects[<project>].roleAgents` (`{ implementer?: agentId, reviewer?: agentId }`; omitted when empty; unknown roles and non-string values are dropped on load).
- `~/.devia-app/devia-app.config.json` → `crossAgent`.

## Config

`DeviaConfig.crossAgent` (`src/shared/domain/config.ts`): `enabled`, `maxConcurrent`, `maxPerTurn`, `defaultTimeoutSec`. Invalid values fall back to the defaults; `maxConcurrent` is capped at 8. The block is optional in the type; read it through `normalizeCrossAgentConfig`.

## Gotchas

- `foldAssistantText` lives in `src/main/shared/stream-text.ts` so features do not import each other; `telegram-controller/application/stream-text.ts` only re-exports it.
- Gateway events carry `project: runKey ?? projectName`, so completion is keyed by run key. An `end` with no previous `start` (busy, early exit) resolves as `failed`.
- A worker run's own events (`process:start`, `claude:output`, `process:end`) reach the renderer keyed by its worker run key, exactly like any run; the renderer must fold them into the controller's thread instead of leaving a ghost session state (T11).
- `RunGateway.submit` accepts `runKey`, `sessionId`, `isolate` and `agentIdOverride` (forwarded by `claude.ipc.ts` to `submitInstruction`); a worker is submitted with origin `renderer`, there is no `subagent` origin: the run key identifies it.
- The runner's own worktree ensure uses `worktreeBaseRef` (default branch) and silently falls back to the base checkout, so the worker's worktree is created explicitly first.
- The idle watchdog of the launcher (5 minutes without stdout/stderr) would kill a controller that waits on a worker, hence `keepAlive`; a controller that is not waiting through this tool is still subject to it.
- A role absent from `roleAgents` has never been asked about; `main` means it was asked and kept with the main (effective) agent. Both resolve to the effective agent, but only `main` stops the question from being asked again (`isRoleSplit` is false for both).

## Tests

`src/shared/domain/cross-agent.test.ts`, `app-state.workers.spec.ts`, `worker-bubble.spec.ts`, `assign-agents.use-case.test.ts`, `ui-assign-card.component.spec.ts`, `cross-agent-config.test.ts`, `src/main/shared/run-completion.test.ts`, `src/main/features/cross-agent/application/*.test.ts`, `src/main/features/workspace/infrastructure/fs-config-repository.cross-agent.test.ts`, `src/main/shared/persistence/fs-state-store.test.ts`. `worker-registry.test.ts`, `spawn-worker.use-case.test.ts`, `integrate-worker.test.ts` (real git repo), `worker-prompt.test.ts`. Not covered yet: a real worker run end to end (T13), the tools and the UI.

## Related

[run-modes.md](run-modes.md), [git.md](git.md), [settings.md](settings.md), [starter-kits.md](starter-kits.md)
