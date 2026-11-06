import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Parser } from 'web-tree-sitter';
import type { CodeGraphLanguage, IndexProgress } from '../../../../../shared/domain/code-graph';
import { openGraphDb, type GraphDb } from '../db/connection';
import { GraphQueries, type FileRow } from '../db/queries';
import { acquireWriterLock } from '../db/writer-lock';
import { discoverFiles, type DiscoveredFile } from '../discovery/discover';
import { isTestFile } from '../discovery/test-detection';
import type { FileExtraction } from '../extraction/extractor';
import { isGeneratedFile } from '../extraction/generated-detection';
import { createParser, grammarVariantForPath, languageForPath } from '../extraction/grammars';
import { extractorFor } from '../extraction/registry';
import { contentHash } from './hash';
import { postIndex } from './post-index';

export const EXTRACTION_VERSION = 1;
export const GRAPH_DB_FILE = 'graph.db';
export const BUILDING_DB_FILE = 'graph.db.building';

const BATCH_SIZE = 100;
const GENERATED_HEAD_BYTES = 2048;

export interface IndexResult {
  nodes: number;
  edges: number;
  files: number;
  skipped: number;
  durationMs: number;
  languages: Partial<Record<CodeGraphLanguage, number>>;
}

export interface IndexProjectOptions {
  root: string;
  dataDir: string;
  onProgress?: (p: IndexProgress) => void;
  signal?: AbortSignal;
  resolve?: (db: GraphQueries) => Promise<void>;
}

export class IndexBusyError extends Error {
  readonly code = 'INDEX_BUSY';

  constructor() {
    super('Another full index is already running for this project');
    this.name = 'IndexBusyError';
  }
}

type FileOutcome =
  | { kind: 'ok'; row: FileRow; extraction: FileExtraction }
  | { kind: 'failed'; row: FileRow }
  | { kind: 'unreadable' };

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Index aborted', 'AbortError');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

function isSupported(rel: string): boolean {
  const lang = languageForPath(rel);
  return lang !== undefined && extractorFor(lang) !== undefined;
}

class ParserPool {
  private readonly parsers = new Map<string, Promise<Parser>>();

  get(lang: CodeGraphLanguage, variant: 'tsx' | undefined): Promise<Parser> {
    const key = `${lang}:${variant ?? ''}`;
    let p = this.parsers.get(key);
    if (!p) {
      p = createParser(lang, variant);
      this.parsers.set(key, p);
    }
    return p;
  }

  async dispose(): Promise<void> {
    for (const p of this.parsers.values()) {
      try {
        (await p).delete();
      } catch {
        // a parser that failed to load has nothing to free
      }
    }
    this.parsers.clear();
  }
}

async function processFile(file: DiscoveredFile, pool: ParserPool): Promise<FileOutcome> {
  const lang = languageForPath(file.relPath);
  const extractor = lang ? extractorFor(lang) : undefined;
  if (!lang || !extractor) return { kind: 'unreadable' };
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(file.absPath);
  } catch {
    return { kind: 'unreadable' };
  }
  const isTest = isTestFile(file.relPath, lang);
  const row: FileRow = {
    path: file.relPath,
    contentHash: contentHash(buf),
    language: lang,
    size: buf.length,
    modifiedAt: Math.round(file.mtimeMs),
    indexedAt: Date.now(),
    nodeCount: 0,
    generated: isGeneratedFile(file.relPath, buf.subarray(0, GENERATED_HEAD_BYTES).toString('utf8')),
    isTest,
  };
  try {
    const parser = await pool.get(lang, grammarVariantForPath(file.relPath));
    const source = buf.toString('utf8');
    const tree = parser.parse(source);
    if (!tree) return { kind: 'failed', row: { ...row, errors: ['parser returned no tree'] } };
    let extraction: FileExtraction;
    try {
      extraction = extractor.extract(file.relPath, source, tree);
    } finally {
      tree.delete();
    }
    if (isTest) for (const n of extraction.nodes) n.isTest = true;
    row.nodeCount = extraction.nodes.length;
    if (extraction.errors.length > 0) row.errors = extraction.errors;
    return { kind: 'ok', row, extraction };
  } catch (err) {
    return { kind: 'failed', row: { ...row, errors: [errorMessage(err)] } };
  }
}

// One SAVEPOINT per file so a single bad file (e.g. a reference to a node id that was
// deduplicated away) is dropped without rolling back the whole batch.
function writeFile(db: GraphDb, q: GraphQueries, outcome: FileOutcome & { kind: 'ok' }): boolean {
  db.exec('SAVEPOINT index_file');
  try {
    q.upsertFile(outcome.row);
    q.insertNodes(outcome.extraction.nodes);
    q.insertEdges(outcome.extraction.edges);
    q.insertUnresolved(outcome.extraction.unresolved);
    db.exec('RELEASE index_file');
    return true;
  } catch (err) {
    db.exec('ROLLBACK TO index_file');
    db.exec('RELEASE index_file');
    q.upsertFile({ ...outcome.row, nodeCount: 0, errors: [errorMessage(err)] });
    return false;
  }
}

// The building DB is switched out of WAL so the rename carries the whole database and
// leaves no -wal/-shm sidecar behind.
function closeForPublish(db: GraphDb): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('PRAGMA journal_mode = DELETE');
  db.close();
}

// Readers may still hold the old graph.db: fold its WAL back in first so that a stale
// graph.db-wal is never replayed against the freshly renamed database.
function retirePublished(dataDir: string): void {
  const published = path.join(dataDir, GRAPH_DB_FILE);
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
    // not a usable database: it is replaced wholesale below
  }
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(published + suffix, { force: true });
    } catch {
      // still mapped by a reader on a platform that forbids unlinking open files
    }
  }
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
    const discovered = await discoverFiles(root, signal ? { isSupported, signal } : { isSupported });
    throwIfAborted(signal);
    filesTotal = discovered.files.length;
    let skipped = discovered.skipped.filter((s) => s.reason !== 'ignored').length;

    db = openGraphDb(buildingPath);
    const q = new GraphQueries(db);
    const languages: Partial<Record<CodeGraphLanguage, number>> = {};
    let indexed = 0;
    emit('parse');

    for (let start = 0; start < discovered.files.length; start += BATCH_SIZE) {
      const batch: FileOutcome[] = [];
      for (const file of discovered.files.slice(start, start + BATCH_SIZE)) {
        throwIfAborted(signal);
        batch.push(await processFile(file, pool));
      }
      throwIfAborted(signal);
      const writeDb = db;
      q.transaction(() => {
        for (const outcome of batch) {
          filesDone++;
          if (outcome.kind === 'unreadable') {
            skipped++;
          } else if (outcome.kind === 'failed') {
            q.upsertFile(outcome.row);
            skipped++;
          } else if (writeFile(writeDb, q, outcome)) {
            indexed++;
            nodes += outcome.extraction.nodes.length;
            edges += outcome.extraction.edges.length;
            languages[outcome.row.language] = (languages[outcome.row.language] ?? 0) + 1;
          } else {
            skipped++;
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
    });
    closeForPublish(db);
    db = undefined;
    throwIfAborted(signal);
    retirePublished(dataDir);
    fs.renameSync(buildingPath, path.join(dataDir, GRAPH_DB_FILE));
    published = true;

    return {
      nodes: counts.nodes,
      edges: counts.edges,
      files: indexed,
      skipped,
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
