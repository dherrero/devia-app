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
- Config `DeviaConfig.crossAgent` (`enabled` false, `maxConcurrent` 3 up to 8, `maxPerTurn` 8, `defaultTimeoutSec` 1800) with a block in Settings › Execution.

## Does NOT

- Does NOT launch workers yet: the registry, the spawn use case, the `devia_spawn_agent` and `devia_assign_agents` tools, the chat bubbles and the Telegram flow are later tasks of S-56.
- Does NOT use `explainError` for the failure messages: S-54 is not on `dev` yet, so they are plain strings.
- Does NOT pick an agent by strength: the mapping is the user's choice.

## Entry points

- `src/main/features/cross-agent/application/resolve-worker-agent.ts:resolveWorkerAgent`
- `src/main/features/cross-agent/application/set-role-agents.use-case.ts:SetRoleAgentsUseCase`
- `src/main/shared/run-completion.ts:createRunCompletion`
- `src/main/shared/ports/run-completion.port.ts:RunCompletion`
- `src/shared/domain/cross-agent.ts` (roles, report, assignment question/reply)
- `src/shared/domain/cross-agent-config.ts:normalizeCrossAgentConfig`
- `src/renderer/app/features/settings/settings-modal/components/settings-execution-section/` (cross-agent block)

## IPC / MCP surface

None yet.

## Persistence

- `~/.devia-app/state.json` → `projects[<project>].roleAgents` (`{ implementer?: agentId, reviewer?: agentId }`; omitted when empty; unknown roles and non-string values are dropped on load).
- `~/.devia-app/devia-app.config.json` → `crossAgent`.

## Config

`DeviaConfig.crossAgent` (`src/shared/domain/config.ts`): `enabled`, `maxConcurrent`, `maxPerTurn`, `defaultTimeoutSec`. Invalid values fall back to the defaults; `maxConcurrent` is capped at 8. The block is optional in the type; read it through `normalizeCrossAgentConfig`.

## Gotchas

- `foldAssistantText` lives in `src/main/shared/stream-text.ts` so features do not import each other; `telegram-controller/application/stream-text.ts` only re-exports it.
- Gateway events carry `project: runKey ?? projectName`, so completion is keyed by run key. An `end` with no previous `start` (busy, early exit) resolves as `failed`.
- A role absent from `roleAgents` means "the main (effective) agent", i.e. do not split that role.

## Tests

`src/shared/domain/cross-agent.test.ts`, `cross-agent-config.test.ts`, `src/main/shared/run-completion.test.ts`, `src/main/features/cross-agent/application/*.test.ts`, `src/main/features/workspace/infrastructure/fs-config-repository.cross-agent.test.ts`, `src/main/shared/persistence/fs-state-store.test.ts`. Not covered yet: everything that launches a worker.

## Related

[run-modes.md](run-modes.md), [git.md](git.md), [settings.md](settings.md), [starter-kits.md](starter-kits.md)
