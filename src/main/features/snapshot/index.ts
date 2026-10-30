import type { Feature, FeatureContext } from '../../shared/feature';
import { SnapshotCreateUseCase } from './application/snapshot-create.use-case';
import { SnapshotListUseCase } from './application/snapshot-list.use-case';
import { SnapshotRestoreUseCase } from './application/snapshot-restore.use-case';
import { SnapshotRetentionUseCase } from './application/snapshot-retention.use-case';
import { SnapshotStore } from './infrastructure/snapshot-store';
import { registerSnapshotIpc } from './ipc/snapshot.ipc';

export interface SnapshotDeps {
  deviaDir: () => string;
}

/**
 * Config snapshot + rollback feature (#270).
 *
 * The create use case is exposed via the returned object so other
 * features wire it into their destructive operations. Read-side
 * IPC (list / restore / pin / delete) is registered as part of the
 * Feature.register lifecycle.
 *
 * Retention runs at boot (via the feature's `onReady` hook) so the
 * user starts a fresh session with a tidy history view.
 */
export interface SnapshotFeatureBuilt extends Feature {
  readonly create: SnapshotCreateUseCase;
  readonly store: SnapshotStore;
}

export function buildSnapshotFeature(deps: SnapshotDeps): SnapshotFeatureBuilt {
  const store = new SnapshotStore(deps.deviaDir);
  const retention = new SnapshotRetentionUseCase(store);
  const create = new SnapshotCreateUseCase(store, retention);
  const list = new SnapshotListUseCase(store);
  const restore = new SnapshotRestoreUseCase(store);

  return {
    id: 'snapshot',
    create,
    store,
    register(ctx: FeatureContext) {
      registerSnapshotIpc(ctx, { list, restore, store });
    },
    onReady() {
      // Sweep stale entries at boot for every known feature.
      for (const f of ['skills', 'mcp', 'prompt-packs', 'manual'] as const) {
        retention.run(f);
      }
    },
  };
}

export { SnapshotCreateUseCase } from './application/snapshot-create.use-case';
export { SnapshotStore } from './infrastructure/snapshot-store';
