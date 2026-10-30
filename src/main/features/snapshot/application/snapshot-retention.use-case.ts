import type {
  SnapshotFeature,
  SnapshotManifest,
} from '../../../../shared/domain/snapshot';
import { SnapshotStore } from '../infrastructure/snapshot-store';

export interface RetentionPolicy {
  /** Max number of unpinned snapshots to keep per feature. */
  readonly maxPerFeature: number;
  /** Max age in days; older snapshots get pruned even if under the
   *  count cap. Pinned snapshots are exempt. */
  readonly maxAgeDays: number;
}

const DEFAULT_POLICY: RetentionPolicy = {
  maxPerFeature: 10,
  maxAgeDays: 30,
};

/**
 * Sweep unpinned snapshots beyond the retention budget. Runs after
 * each create() and on app boot (composition root). Pinned snapshots
 * are protected unconditionally.
 *
 * "Snapshots are forever unless you say so" violates the principle
 * of least surprise: a user that runs hundreds of skill installs
 * would otherwise watch ~/.devia-app/snapshots/ balloon. 10 per
 * feature is plenty for the typical "I made a mistake, undo it now"
 * recovery window.
 */
export class SnapshotRetentionUseCase {
  constructor(
    private readonly store: SnapshotStore,
    private readonly policy: RetentionPolicy = DEFAULT_POLICY,
  ) {}

  run(feature: SnapshotFeature): void {
    const manifests = this.store
      .listManifests(feature)
      .sort((a, b) => b.createdAt - a.createdAt);

    const cutoff = Date.now() - this.policy.maxAgeDays * 24 * 60 * 60 * 1000;
    const toDelete: SnapshotManifest[] = [];

    let kept = 0;
    for (const m of manifests) {
      if (m.pinned) continue; // never touched by retention
      kept++;
      if (kept > this.policy.maxPerFeature || m.createdAt < cutoff) {
        toDelete.push(m);
      }
    }

    for (const m of toDelete) {
      this.store.removeSnapshot(m.feature, m.id);
    }
  }
}
