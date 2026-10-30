import type { QueueItem } from '../../../../shared/domain/queue';

/**
 * On-disk durability for the queue. The implementation owns the file
 * format and the atomic-write strategy; the service only sees a typed
 * view of "per project: items + paused flag".
 *
 * `load` is synchronous on purpose — the composition root calls it
 * before the BrowserWindow is created so persisted queues are visible
 * the moment the renderer subscribes.
 */
export interface QueueRepositorySnapshot {
  items: QueueItem[];
  paused: boolean;
}

export interface QueueRepository {
  load(): Map<string, QueueRepositorySnapshot>;
  save(state: ReadonlyMap<string, QueueRepositorySnapshot>): void;
  /** Forces a pending debounced save to flush — used on app quit. */
  flush(): void;
}

/**
 * The queue feature does not know how to run a Claude turn. It calls
 * back into the runner via this port. The composition root injects an
 * adapter that wraps `RunInstructionUseCase` with the same per-project
 * handlers used by the IPC layer.
 *
 * Two return shapes:
 *  - `dispatched: true` → the runner accepted the call and we own
 *    bookkeeping (the runner will emit process:end which the service
 *    listens for to dequeue the next item).
 *  - `dispatched: false` → the project was busy/missing config and
 *    dispatching is a no-op. The service keeps the item at the head
 *    so the user can manually retry.
 */
export interface InstructionDispatcher {
  /** Returns false if the runner couldn't start (busy, no workspace, …).
   *  `item` carries the queued metadata: displayText for the renderer bubble,
   *  mode so a queued PLAN run doesn't dispatch as 'apply', and origin so a
   *  queued remote (Telegram) run keeps its remote behavior. */
  dispatch(projectName: string, text: string, item?: QueueItem): boolean;
}
