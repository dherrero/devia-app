import type {
  ListSnapshotsQuery,
  SnapshotSummary,
} from '../../../../shared/domain/snapshot';
import { SnapshotStore } from '../infrastructure/snapshot-store';

/**
 * Renderer-facing listing — collapses manifests into summaries so the
 * history UI doesn't pull the entire `entries[]` array across IPC.
 *
 * Default ordering: newest first. Pinned snapshots interleave with
 * unpinned ones rather than being grouped — the UI shows the pin
 * state as a chip so the order stays "chronological" intuitively.
 */
export class SnapshotListUseCase {
  constructor(private readonly store: SnapshotStore) {}

  execute(query: ListSnapshotsQuery = {}): SnapshotSummary[] {
    const limit = query.limit ?? 50;
    const manifests = this.store.listManifests(query.feature);

    const filtered = query.projectPath
      ? manifests.filter((m) => m.projectPath === query.projectPath)
      : manifests;

    return filtered
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((m) => {
        const summary: SnapshotSummary = {
          id: m.id,
          createdAt: m.createdAt,
          feature: m.feature,
          reason: m.reason,
          fileCount: m.entries.length,
          pinned: m.pinned,
          ...(m.projectPath !== undefined && { projectPath: m.projectPath }),
        };
        return summary;
      });
  }
}
