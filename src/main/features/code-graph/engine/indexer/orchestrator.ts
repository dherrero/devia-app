import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CodeGraphLanguage, IndexProgress } from '../../../../../shared/domain/code-graph';
import { openGraphDb, type GraphDb } from '../db/connection';
import { GraphQueries } from '../db/queries';
import { acquireWriterLock } from '../db/writer-lock';
import { discoverFiles, type SkipReason } from '../discovery/discover';
import { extractFile, isSupported, ParserPool, writeExtraction, type FileOutcome } from './extract-file';
import { postIndex } from './post-index';
import { CONFIG_HASHES_KEY, isResolutionConfig, resolutionConfigHashes } from './resolution-config';

/**
 * Bump when extractors change what they store: v2 adds receiver type facts (S-44 T-515), v3 the
 * Java/Go/Dart/Python ones and type parameter bounds.
 */
export const EXTRACTION_VERSION = 3;
export const GRAPH_DB_FILE = 'graph.db';
export const BUILDING_DB_FILE = 'graph.db.building';

const DEFAULT_BATCH_SIZE = 100;
const SWAP_ATTEMPTS = 8;
const SWAP_BASE_DELAY_MS = 100;
const SWAP_MAX_DELAY_MS = 800;

/** Why a source file is not in the graph: a discovery rule, or extraction could not read or store it. */
export type IndexSkipReason = Exclude<SkipReason, 'ignored'> | 'parse-failed';

export interface SkippedFile {
  path: string;
  reason: IndexSkipReason;
}

export interface IndexResult {
  nodes: number;
  edges: number;
  files: number;
  skipped: number;
  /** One entry per skipped path (`skipped` is its length); ignored paths are not listed. */
  skippedFiles: SkippedFile[];
  durationMs: number;
  languages: Partial<Record<CodeGraphLanguage, number>>;
}

export interface IndexProjectOptions {
  root: string;
  dataDir: string;
  onProgress?: (p: IndexProgress) => void;
  signal?: AbortSignal;
  resolve?: (db: GraphQueries) => Promise<void>;
  batchSize?: number;
  renameFile?: (from: string, to: string) => void;
}

export class IndexBusyError extends Error {
  readonly code = 'INDEX_BUSY';

  constructor() {
    super('Another full index is already running for this project');
    this.name = 'IndexBusyError';
  }
}

export class IndexSwapBusyError extends Error {
  readonly code = 'INDEX_SWAP_BUSY';

  constructor() {
    super('graph.db stayed busy; the previous graph was kept');
    this.name = 'IndexSwapBusyError';
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Index aborted', 'AbortError');
}

export function removeBuildingFiles(dataDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dataDir);
  } catch {
    return;
  }
  for (const name of names)
    if (name.startsWith(BUILDING_DB_FILE)) fs.rmSync(path.join(dataDir, name), { force: true });
}

// The building DB is switched out of WAL so the rename carries the whole database and
// leaves no -wal/-shm sidecar behind.
function closeForPublish(db: GraphDb): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('PRAGMA journal_mode = DELETE');
  db.close();
}

function checkpointPublished(published: string): void {
  if (!fs.existsSync(published)) return;
  try {
    const old = new DatabaseSync(published);
    try {
      old.exec('PRAGMA busy_timeout = 5000');
      old.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      old.close();
    }
  } catch {
    // not a usable database: it is replaced wholesale by the rename
  }
}

function removeSidecars(published: string): void {
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(published + suffix, { force: true });
    } catch {
      // still mapped by a reader on a platform that forbids unlinking open files
    }
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Contract with readers (MCP, UI): they open graph.db READONLY per request and close it
// before returning, never holding it between requests. That keeps the window where the
// old file is open short, so a busy rename (Windows) is retried rather than failed, and
// the old -wal/-shm are dropped right before the rename so they are never replayed
// against the new database.
async function publish(
  buildingPath: string,
  published: string,
  rename: (from: string, to: string) => void,
): Promise<void> {
  checkpointPublished(published);
  for (let attempt = 0; attempt < SWAP_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(Math.min(SWAP_MAX_DELAY_MS, SWAP_BASE_DELAY_MS * 2 ** (attempt - 1)));
    removeSidecars(published);
    try {
      rename(buildingPath, published);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw err;
    }
  }
  throw new IndexSwapBusyError();
}

export async function indexProject(opts: IndexProjectOptions): Promise<IndexResult> {
  const { root, dataDir, signal } = opts;
  fs.mkdirSync(dataDir, { recursive: true });
  const lock = acquireWriterLock(dataDir, 'indexer');
  if (!lock) throw new IndexBusyError();

  const started = Date.now();
  const buildingPath = path.join(dataDir, BUILDING_DB_FILE);
  const pool = new ParserPool();
  let db: GraphDb | undefined;
  let published = false;
  try {
    removeBuildingFiles(dataDir);
    let filesDone = 0;
    let filesTotal = 0;
    let nodes = 0;
    let edges = 0;
    const emit = (phase: IndexProgress['phase']): void =>
      opts.onProgress?.({ phase, filesDone, filesTotal, nodes, edges });

    emit('discover');
    const discoverOpts = { isSupported, isConfig: isResolutionConfig };
    const discovered = await discoverFiles(root, signal ? { ...discoverOpts, signal } : discoverOpts);
    throwIfAborted(signal);
    filesTotal = discovered.files.length;
    const skippedFiles: SkippedFile[] = [];
    for (const s of discovered.skipped) if (s.reason !== 'ignored') skippedFiles.push({ path: s.path, reason: s.reason });

    db = openGraphDb(buildingPath);
    const q = new GraphQueries(db);
    const languages: Partial<Record<CodeGraphLanguage, number>> = {};
    let indexed = 0;
    emit('parse');

    const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
    for (let start = 0; start < discovered.files.length; start += batchSize) {
      const batch: FileOutcome[] = [];
      for (const file of discovered.files.slice(start, start + batchSize)) {
        throwIfAborted(signal);
        batch.push(await extractFile(file, pool));
      }
      throwIfAborted(signal);
      const writeDb = db;
      q.transaction(() => {
        for (const outcome of batch) {
          filesDone++;
          if (outcome.kind === 'unreadable') {
            skippedFiles.push({ path: outcome.path, reason: 'unreadable' });
          } else if (outcome.kind === 'failed') {
            q.upsertFile(outcome.row);
            skippedFiles.push({ path: outcome.row.path, reason: 'parse-failed' });
          } else if (writeExtraction(writeDb, q, outcome)) {
            indexed++;
            nodes += outcome.extraction.nodes.length;
            edges += outcome.extraction.edges.length;
            languages[outcome.row.language] = (languages[outcome.row.language] ?? 0) + 1;
          } else {
            skippedFiles.push({ path: outcome.row.path, reason: 'parse-failed' });
          }
        }
      });
      emit('parse');
    }

    emit('resolve');
    await (opts.resolve ?? ((g: GraphQueries) => postIndex(g, root)))(q);
    throwIfAborted(signal);

    const counts = q.counts();
    nodes = counts.nodes;
    edges = counts.edges;
    emit('finalize');
    q.transaction(() => {
      q.setMeta('indexed_at', String(Date.now()));
      q.setMeta('root', root);
      q.setMeta('extraction_version', String(EXTRACTION_VERSION));
      q.setMeta('languages', JSON.stringify(languages));
      q.setMeta(
        CONFIG_HASHES_KEY,
        JSON.stringify(
          resolutionConfigHashes(
            root,
            discovered.files.map((f) => f.relPath),
            discovered.configs.map((f) => f.relPath),
          ),
        ),
      );
    });
    closeForPublish(db);
    db = undefined;
    throwIfAborted(signal);
    await publish(buildingPath, path.join(dataDir, GRAPH_DB_FILE), opts.renameFile ?? fs.renameSync);
    published = true;

    return {
      nodes: counts.nodes,
      edges: counts.edges,
      files: indexed,
      skipped: skippedFiles.length,
      skippedFiles,
      durationMs: Date.now() - started,
      languages,
    };
  } finally {
    await pool.dispose();
    if (db) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    if (!published) removeBuildingFiles(dataDir);
    lock.release();
  }
}
