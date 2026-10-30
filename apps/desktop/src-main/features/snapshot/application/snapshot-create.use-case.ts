import type {
  CreateSnapshotRequest,
  CreateSnapshotResult,
  SnapshotManifest,
} from '../../../../shared/domain/snapshot';
import {
  SnapshotStore,
  fingerprintForRequest,
  newSnapshotId,
} from '../infrastructure/snapshot-store';
import type { SnapshotRetentionUseCase } from './snapshot-retention.use-case';

/**
 * Captures the current state of the requested files into a new
 * snapshot — or reuses an existing snapshot when the fingerprint
 * matches. The caller (skill installer, MCP register, etc.) MUST
 * invoke this BEFORE the destructive write, so the "undo" is
 * meaningful.
 *
 * Dedup contract:
 *   The fingerprint covers the absolute path + sha256 of every input
 *   file. Two consecutive create() with the same paths and same on-
 *   disk content return the same id without rewriting the archive.
 *   This is a performance optimisation AND a correctness guarantee:
 *   if the caller naively wraps every destructive op, we don't
 *   pollute history with duplicate snapshots when nothing changed.
 */
export class SnapshotCreateUseCase {
  constructor(
    private readonly store: SnapshotStore,
    private readonly retention: SnapshotRetentionUseCase,
  ) {}

  execute(req: CreateSnapshotRequest): CreateSnapshotResult {
    const fingerprint = fingerprintForRequest(req);

    // Dedup: same feature + same fingerprint + non-pinned → reuse.
    // We only check the most recent N manifests so the dedup probe
    // stays O(1) even after months of usage.
    const recent = this.store
      .listManifests(req.feature)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20);
    const hit = recent.find(
      (m) =>
        m.fingerprint === fingerprint &&
        // Don't dedup when the reason or project changes — same files,
        // different intent, still useful to record a fresh entry.
        m.reason === req.reason &&
        normaliseProject(m.projectPath) === normaliseProject(req.projectPath),
    );
    if (hit) return { id: hit.id, deduped: true };

    const id = newSnapshotId();
    const manifest: SnapshotManifest = this.store.write(req, id);
    // Retention sweep AFTER the write so the just-created (unpinned)
    // snapshot isn't itself pruned.
    this.retention.run(manifest.feature);
    return { id: manifest.id, deduped: false };
  }
}

function normaliseProject(p: string | undefined): string {
  return p ?? '';
}
