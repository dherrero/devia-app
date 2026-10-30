import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  SnapshotFeature,
  SnapshotRestoreResult,
} from '../../../../shared/domain/snapshot';
import { SnapshotStore } from '../infrastructure/snapshot-store';

export interface RestoreOptions {
  /**
   * Opt-in drift protection. When `true`, an entry whose current
   * sha256 differs from the snapshot's captured sha256 is reported
   * under `drift` instead of being overwritten. Default false:
   * snapshots are "ground truth" for undo, so restore overwrites
   * unconditionally and the renderer prompts via confirm dialog if
   * the operation is large enough to warrant it.
   *
   * Drift detection is most useful for the history modal's manual
   * "Restaurar" button — the snapshot may be days old and the user
   * has had time to make further changes. The per-feature undo toast
   * (clicked seconds after the destructive op) leaves it off.
   */
  readonly safe?: boolean;
}

/**
 * Reverts every file in a snapshot to its captured state.
 *
 * Files marked `existed: false` at capture are re-deleted by restore
 * — that's how we undo a destructive op that created new files (e.g.
 * `specify init` writing `.specify/` + `specs/`).
 */
export class SnapshotRestoreUseCase {
  constructor(private readonly store: SnapshotStore) {}

  execute(
    feature: SnapshotFeature,
    id: string,
    options: RestoreOptions = {},
  ): SnapshotRestoreResult {
    const manifest = this.store.readManifestById(feature, id);
    if (!manifest) {
      return {
        restored: [],
        drift: [],
        failed: [{ path: id, error: 'Snapshot no encontrado' }],
      };
    }

    const restored: string[] = [];
    const drift: SnapshotRestoreResult['drift'] = [] as SnapshotRestoreResult['drift'];
    const failed: SnapshotRestoreResult['failed'] = [] as SnapshotRestoreResult['failed'];

    for (const entry of manifest.entries) {
      try {
        if (entry.existed && entry.sha256) {
          // Drift protection is opt-in via `safe: true`. See
          // RestoreOptions for the rationale.
          if (options.safe) {
            const current = currentSha256(entry.path);
            if (current !== null && current !== entry.sha256) {
              (drift as Array<{ path: string; currentSha256: string; snapshotSha256: string }>).push({
                path: entry.path,
                currentSha256: current,
                snapshotSha256: entry.sha256,
              });
              continue;
            }
          }

          const buf = this.store.readEntryContent(manifest.feature, manifest.id, entry);
          if (!buf) {
            (failed as Array<{ path: string; error: string }>).push({
              path: entry.path,
              error: 'Blob de snapshot vacío',
            });
            continue;
          }
          fs.mkdirSync(path.dirname(entry.path), { recursive: true });
          fs.writeFileSync(entry.path, buf);
          restored.push(entry.path);
        } else {
          // Re-delete files the destructive op created.
          if (safeIsFile(entry.path)) {
            fs.rmSync(entry.path, { force: true });
            restored.push(entry.path);
          }
        }
      } catch (err) {
        (failed as Array<{ path: string; error: string }>).push({
          path: entry.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { restored, drift, failed };
  }
}

function currentSha256(p: string): string | null {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

function safeIsFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
