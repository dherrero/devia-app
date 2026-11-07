import * as fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { openGraphDb } from '../engine/db/connection';
import { GraphQueries } from '../engine/db/queries';

export interface SeedCopyData {
  /** Base graph.db, opened read-only. */
  src: string;
  /** Destination of the snapshot (must not exist). */
  tmp: string;
  /** Project root stored in the copy's metadata. */
  root: string;
}

export type SeedCopyMessage = { type: 'done' } | { type: 'error'; message: string };

function copy({ src, tmp, root }: SeedCopyData): void {
  // VACUUM INTO yields a consistent snapshot even with a live WAL reader/writer.
  const from = openGraphDb(src, { readonly: true });
  try {
    from.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    from.close();
  }
  const to = openGraphDb(tmp);
  try {
    // The copied root is the base path; sync treats a different root as "full index required".
    new GraphQueries(to).setMeta('root', root);
    to.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    to.close();
  }
  for (const suffix of ['-wal', '-shm']) fs.rmSync(tmp + suffix, { force: true });
}

function run(): void {
  const port = parentPort;
  if (!port) return;
  try {
    copy(workerData as SeedCopyData);
    port.postMessage({ type: 'done' } satisfies SeedCopyMessage);
  } catch (err) {
    port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies SeedCopyMessage);
  }
}

run();
