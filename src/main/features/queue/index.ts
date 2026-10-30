import type { Feature, FeatureContext } from '../../shared/feature';
import type { ConfigRepository, ProjectRegistry } from '../../shared/ports';
import { QueueService } from './application/queue-service';
import { FsQueueRepository } from './infrastructure/fs-queue-store';
import { registerQueueIpc } from './ipc/queue.ipc';
import type { InstructionDispatcher } from './domain/ports';

export type { InstructionDispatcher, QueueRepository } from './domain/ports';
export { QueueService } from './application/queue-service';

export interface QueueFeatureDeps {
  config: ConfigRepository;
  registry: ProjectRegistry;
}

export interface QueueFeatureBuilt {
  feature: Feature;
  service: QueueService;
}

/**
 * Builds the queue feature in two phases:
 *  1. Construct the service + repo + load disk state synchronously — the
 *     composition root needs `service` accessible immediately so the
 *     claude-runner IPC can call into it.
 *  2. The `register()` callback wires the IPC handlers and emits the
 *     initial `queue:changed` events to whichever renderer attaches.
 *
 * The dispatcher (which actually re-runs a popped instruction) is
 * attached separately by the composition root because it depends on the
 * runner — a circular reference if both wanted the other at construction
 * time.
 */
export function buildQueueFeature(deps: QueueFeatureDeps): QueueFeatureBuilt {
  const repo = new FsQueueRepository(deps.config);

  // Built first so the composition root can `service.hydrate(repo.load())`
  // and `service.attachDispatcher(...)` before `register()` runs.
  const service = new QueueService({
    repo,
    registry: deps.registry,
  });

  const feature: Feature = {
    id: 'queue',
    register(ctx: FeatureContext) {
      service.attachNotify((e) => ctx.send('queue:changed', e));
      registerQueueIpc(ctx, { service });
    },
    onBeforeQuit() {
      // Flush pending debounced save so we never lose enqueues after a
      // graceful quit.
      repo.flush();
    },
  };

  // Synchronous load — composition root expects the queue state to be
  // observable before any renderer subscribes.
  service.hydrate(repo.load());

  return { feature, service };
}

/**
 * Factory for the dispatcher port. Lives next to the feature so callers
 * stay in one import. The composition root passes in the runner's
 * use case + a `runHandlers` factory (the same it uses for the IPC
 * call); the queue calls this when a process ends and the head item
 * needs to actually fire.
 */
export function createInstructionDispatcher(opts: {
  run: (projectName: string, text: string) => boolean;
}): InstructionDispatcher {
  return { dispatch: opts.run };
}
