# Instruction queue

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Per-project queue of instructions typed while the agent is busy; dispatched in order when the run ends.

## Does

- `QueueService` (`src/main/features/queue/application/queue-service.ts`) owns in-memory queues per session identity and the side effects of mutating one (persist + notify the renderer).
- `shouldEnqueue(projectName)` is what the runner asks: true while a run is active, or when the queue is paused with at least one parked item.
- Operations: add, remove, edit text, move (reorder by drag-drop), clear, pause, resume, list; every mutation pushes `queue:changed`; a dispatched item pushes `queue:dispatched`.
- The queue is keyed by session identity (`runKey ?? project`), so split panes have separate queues. Items keep `origin` (desktop/remote) and `agentIdOverride`, so a Telegram instruction queued while busy stays remote.
- Persisted atomically (temp file + rename) to `~/.devia-app/queues.json` by `FsQueueRepository`.
- Renderer: `QueuePanelComponent` (`src/renderer/app/features/chat/queue/queue-panel.component.ts`).
- Paused while an auto-resume is pending ([auto-continue.md](auto-continue.md)); `/clean` and session reset clear the queue.

## Does NOT

- Does NOT run instructions in parallel for one session: strictly one at a time.
- Does NOT dispatch while paused or while a resume is pending.
- Does NOT survive deletion of the project: trashing a project drops its sessions and registry entries.

## Entry points

- `src/main/features/queue/index.ts:buildQueueFeature` — wiring
- `src/main/features/queue/application/queue-service.ts:QueueService` — state and dispatch
- `src/main/features/queue/infrastructure/fs-queue-store.ts:FsQueueRepository` — persistence
- `src/main/features/queue/ipc/queue.ipc.ts` — IPC
- `src/shared/domain/queue.ts:QueueItem` — item shape

## IPC / MCP surface

- `queue:list`, `queue:add`, `queue:remove`, `queue:edit`, `queue:move`, `queue:clear`, `queue:pause`, `queue:resume`, `queue:changed`, `queue:dispatched`.

## Persistence

`~/.devia-app/queues.json`.

## Config

None.

## Gotchas

- The runner depends on `shouldEnqueue`, and the dispatcher/notifier are attached after construction (they depend on services that depend on the queue).

## Tests

`src/main/features/queue/**/*.test.ts`.

## Related

[claude-runner.md](claude-runner.md), [auto-continue.md](auto-continue.md), [chat-ui.md](chat-ui.md), [telegram-controller.md](telegram-controller.md)
