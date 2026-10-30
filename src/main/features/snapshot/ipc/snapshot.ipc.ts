import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type {
  ListSnapshotsQuery,
  SnapshotFeature,
} from '../../../../shared/domain/snapshot';
import { SnapshotListUseCase } from '../application/snapshot-list.use-case';
import { SnapshotRestoreUseCase } from '../application/snapshot-restore.use-case';
import { SnapshotStore } from '../infrastructure/snapshot-store';

/**
 * Read-side IPC adapter for the snapshot feature (#270).
 *
 *   - snapshot:list    → recent SnapshotSummary[].
 *   - snapshot:restore → run a restore, return per-file result.
 *   - snapshot:pin     → toggle the protection-from-retention flag.
 *   - snapshot:delete  → permanently delete a snapshot.
 *
 * The write side (`snapshot:create`) is NOT exposed via IPC. Each
 * destructive feature calls `SnapshotCreateUseCase` directly inside
 * its own use case so the snapshot is guaranteed to land BEFORE the
 * mutation. Exposing create on the renderer would risk the renderer
 * forgetting to call it.
 */
export function registerSnapshotIpc(
  ctx: FeatureContext,
  deps: {
    list: SnapshotListUseCase;
    restore: SnapshotRestoreUseCase;
    store: SnapshotStore;
  },
): void {
  ctx.ipc.handle(IPC.snapshotList, (_e, query: ListSnapshotsQuery | undefined) =>
    deps.list.execute(query ?? {}));

  ctx.ipc.handle(
    IPC.snapshotRestore,
    (_e, feature: SnapshotFeature, id: string, options?: { safe?: boolean }) =>
      deps.restore.execute(feature, id, options ?? {}),
  );

  ctx.ipc.handle(
    IPC.snapshotPin,
    (_e, feature: SnapshotFeature, id: string, pinned: boolean) => {
      const manifest = deps.store.readManifestById(feature, id);
      if (manifest) deps.store.writeManifest({ ...manifest, pinned });
      return true as const;
    },
  );

  ctx.ipc.handle(IPC.snapshotDelete, (_e, feature: SnapshotFeature, id: string) => {
    deps.store.removeSnapshot(feature, id);
    return true as const;
  });
}
