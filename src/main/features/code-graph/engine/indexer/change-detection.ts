import * as fs from 'node:fs';
import type { FileRow, GraphQueries } from '../db/queries';
import type { DiscoveredFile } from '../discovery/discover';
import { contentHash } from './hash';

export interface ChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
  /** Same content, new mtime: only the stored mtime needs refreshing. */
  touched: { path: string; modifiedAt: number }[];
}

/**
 * Compares the discovered tree with the `files` rows. A file is `modified` only when its mtime
 * or size moved AND its content hash differs: an mtime change alone never re-extracts.
 * A file that can no longer be read counts as modified so the sync drops its stale nodes.
 */
export function detectChanges(
  db: GraphQueries,
  discovered: DiscoveredFile[],
  rows: ReadonlyMap<string, FileRow> = new Map(db.fileRecords().map((r) => [r.path, r])),
): ChangeSet {
  const out: ChangeSet = { added: [], modified: [], deleted: [], touched: [] };
  const seen = new Set<string>();
  for (const file of discovered) {
    seen.add(file.relPath);
    const row = rows.get(file.relPath);
    if (!row) {
      out.added.push(file.relPath);
      continue;
    }
    const modifiedAt = Math.round(file.mtimeMs);
    if (modifiedAt === row.modifiedAt && file.size === row.size) continue;
    let hash: string | undefined;
    try {
      hash = contentHash(fs.readFileSync(file.absPath));
    } catch {
      hash = undefined;
    }
    if (hash === row.contentHash) out.touched.push({ path: file.relPath, modifiedAt });
    else out.modified.push(file.relPath);
  }
  for (const p of rows.keys()) if (!seen.has(p)) out.deleted.push(p);
  out.added.sort();
  out.modified.sort();
  out.deleted.sort();
  return out;
}
