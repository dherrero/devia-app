import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type { QueueService } from '../application/queue-service';

export interface QueueIpcDeps {
  service: QueueService;
}

/**
 * IPC surface for the per-project queue.
 *
 * Every mutating call returns the affected boolean/item directly so the
 * renderer can react synchronously where useful (e.g. inline edit
 * rollback when the item was meanwhile removed by a process:end pop),
 * but the canonical state for the UI flows through the `queue:changed`
 * event the service emits on every mutation.
 */
export function registerQueueIpc(ctx: FeatureContext, deps: QueueIpcDeps): void {
  ctx.ipc.handle(IPC.queueList, (_e, projectName: string) =>
    deps.service.view(projectName));

  ctx.ipc.handle(IPC.queueAdd, (_e, projectName: string, text: string) =>
    deps.service.add(projectName, text));

  ctx.ipc.handle(IPC.queueRemove, (_e, projectName: string, id: string) =>
    deps.service.remove(projectName, id));

  ctx.ipc.handle(IPC.queueEdit, (_e, projectName: string, id: string, text: string) =>
    deps.service.edit(projectName, id, text));

  ctx.ipc.handle(IPC.queueMove, (_e, projectName: string, id: string, newIndex: number) =>
    deps.service.move(projectName, id, newIndex));

  ctx.ipc.handle(IPC.queueClear, (_e, projectName: string) =>
    deps.service.clear(projectName));

  ctx.ipc.handle(IPC.queuePause, (_e, projectName: string) =>
    deps.service.pause(projectName));

  ctx.ipc.handle(IPC.queueResume, (_e, projectName: string) =>
    deps.service.resume(projectName));
}
