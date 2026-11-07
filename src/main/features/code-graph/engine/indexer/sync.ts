import * as fs from 'node:fs';
import * as path from 'node:path';
import { openGraphDb, type GraphDb } from '../db/connection';
import { GraphQueries, type FileRow } from '../db/queries';
import { acquireWriterLock } from '../db/writer-lock';
import {
  discoverFiles,
  discoverPaths,
  toProjectPath,
  type DiscoveredFile,
  type DiscoverOptions,
  type DiscoverResult,
} from '../discovery/discover';
import { makeNodeId } from '../extraction/node-id';
import { fileStem } from '../resolution/resolver';
import { detectChanges, type ChangeSet } from './change-detection';
import { extractFile, isSupported, ParserPool, writeExtraction, type FileOutcome } from './extract-file';
import { EXTRACTION_VERSION, GRAPH_DB_FILE } from './orchestrator';
import { resolveGraph } from './post-index';
import { isResolutionConfig, resolutionConfigHashes, sameConfigHashes, storedConfigHashes } from './resolution-config';

// Adapted from codegraph (MIT), src/sync/ and the `sync` entry point of src/index.ts.

export interface SyncOptions {
  root: string;
  dataDir: string;
  /** Changed files admitted per call; the rest is picked up by the next sync. */
  maxFiles?: number;
  /**
   * Soft time budget. The first changed file (in path order) is always applied, with
   * everything it drags along; further files are admitted only while time remains, so
   * every call makes progress and a busy tree converges over a few calls.
   */
  deadlineMs?: number;
  /**
   * Look only at these files (relative to the root, or absolute inside it). A path that is
   * not indexed under that exact spelling but is under another casing uses the indexed one.
   * Directories are skipped, never expanded.
   */
  onlyPaths?: string[];
}

export interface SyncResult {
  added: number;
  modified: number;
  deleted: number;
  skippedBusy: boolean;
  truncated: boolean;
  /** Nothing was applied: a resolution config, the extraction version or the root changed. */
  fullIndexRequired: boolean;
}

export class GraphNotFoundError extends Error {
  readonly code = 'GRAPH_NOT_FOUND';

  constructor(dataDir: string) {
    super(`No code graph in ${dataDir}; run a full index first`);
    this.name = 'GraphNotFoundError';
  }
}

type ChangeKind = 'added' | 'modified' | 'deleted';
type OkOutcome = FileOutcome & { kind: 'ok' };

const EMPTY: SyncResult = {
  added: 0,
  modified: 0,
  deleted: 0,
  skippedBusy: false,
  truncated: false,
  fullIndexRequired: false,
};

/**
 * Brings graph.db up to date with the tree, giving exactly the graph a full reindex would.
 * Resolved refs are deleted from `unresolved_refs`, so every file whose resolution could
 * change ("dependents") is re-extracted and resolved again together with the changed files.
 * Reading and parsing happen first; all writes then go in one transaction, so a crash or an
 * exception leaves the previous consistent graph.
 */
export async function syncProject(opts: SyncOptions): Promise<SyncResult> {
  const { root, dataDir } = opts;
  const dbPath = path.join(dataDir, GRAPH_DB_FILE);
  if (!fs.existsSync(dbPath)) throw new GraphNotFoundError(dataDir);
  const lock = acquireWriterLock(dataDir, 'sync');
  if (!lock) return { ...EMPTY, skippedBusy: true };

  const started = Date.now();
  const timeLeft = (): boolean => opts.deadlineMs === undefined || Date.now() - started < opts.deadlineMs;
  const pool = new ParserPool();
  let db: GraphDb | undefined;
  try {
    if (!fs.existsSync(dbPath)) throw new GraphNotFoundError(dataDir);
    db = openGraphDb(dbPath);
    const q = new GraphQueries(db);
    if (q.getMeta('extraction_version') !== String(EXTRACTION_VERSION) || !sameRoot(q.getMeta('root'), root))
      return { ...EMPTY, fullIndexRequired: true };

    const rows = new Map(q.fileRecords().map((r) => [r.path, r]));
    const scope = opts.onlyPaths ? scopePaths(root, opts.onlyPaths, rows) : undefined;
    const discoverOpts: Omit<DiscoverOptions, 'signal'> = {
      isSupported,
      isConfig: isResolutionConfig,
      isKnown: (rel, size, mtimeMs) => {
        const row = rows.get(rel);
        return row !== undefined && row.size === size && row.modifiedAt === Math.round(mtimeMs);
      },
    };
    const discovered = scope
      ? await discoverPaths(root, [...scope], discoverOpts)
      : await discoverFiles(root, discoverOpts);
    if (!configsUnchanged(q, root, discovered, rows, scope)) return { ...EMPTY, fullIndexRequired: true };

    const changes = detectChanges(q, discovered.files, rows);
    if (scope) changes.deleted = changes.deleted.filter((p) => scope.has(p));
    const plan = await planSync(q, root, changes, discovered, rows, scope, opts.maxFiles, timeLeft, pool);
    applyPlan(db, q, root, plan);
    const count = (kind: ChangeKind): number => [...plan.changed.values()].filter((k) => k === kind).length;
    return {
      ...EMPTY,
      added: count('added'),
      modified: count('modified'),
      deleted: count('deleted'),
      truncated: plan.truncated,
    };
  } finally {
    await pool.dispose();
    db?.close();
    lock.release();
  }
}

function sameRoot(stored: string | undefined, root: string): boolean {
  return stored !== undefined && path.resolve(stored) === path.resolve(root);
}

function scopePaths(root: string, paths: string[], rows: ReadonlyMap<string, FileRow>): Set<string> {
  const byLower = new Map<string, string>();
  for (const p of rows.keys()) byLower.set(p.toLowerCase(), p);
  const out = new Set<string>();
  for (const p of paths) {
    const rel = toProjectPath(root, p);
    if (rel === undefined) continue;
    out.add(rows.has(rel) ? rel : (byLower.get(rel.toLowerCase()) ?? rel));
  }
  return out;
}

/**
 * With `onlyPaths` the tree is not walked: the indexed files stand in for the tree, so the
 * stored Go/Dart manifests are re-hashed and the tsconfig closure is recomputed from them.
 */
function configsUnchanged(
  q: GraphQueries,
  root: string,
  discovered: DiscoverResult,
  rows: ReadonlyMap<string, FileRow>,
  scope: Set<string> | undefined,
): boolean {
  const stored = storedConfigHashes(q);
  if (!stored) return false;
  const sources = discovered.files.map((f) => f.relPath);
  const manifests = discovered.configs.map((f) => f.relPath);
  if (scope) {
    sources.push(...rows.keys());
    manifests.push(...Object.keys(stored).filter(isResolutionConfig));
  }
  return sameConfigHashes(resolutionConfigHashes(root, sources, manifests), stored);
}

interface SyncPlan {
  changed: Map<string, ChangeKind>;
  outcomes: Map<string, FileOutcome>;
  dependents: Map<string, OkOutcome>;
  touched: ChangeSet['touched'];
  truncated: boolean;
}

async function planSync(
  q: GraphQueries,
  root: string,
  changes: ChangeSet,
  discovered: DiscoverResult,
  rows: ReadonlyMap<string, FileRow>,
  scope: Set<string> | undefined,
  maxFiles: number | undefined,
  timeLeft: () => boolean,
  pool: ParserPool,
): Promise<SyncPlan> {
  const pending = new Map<string, ChangeKind>();
  for (const p of changes.deleted) pending.set(p, 'deleted');
  for (const p of changes.added) pending.set(p, 'added');
  for (const p of changes.modified) pending.set(p, 'modified');

  const byPath = new Map(discovered.files.map((f) => [f.relPath, f]));
  const changed = new Map<string, ChangeKind>();
  const outcomes = new Map<string, FileOutcome>();
  const dependents = new Map<string, OkOutcome>();

  const locate = async (rel: string): Promise<DiscoveredFile | undefined> =>
    byPath.get(rel) ?? (scope ? (await discoverPaths(root, [rel], { isSupported })).files[0] : undefined);

  // Re-extracts the changed files and their dependents until no dependent turns out to be
  // changed itself; never stopped by the deadline, so whatever was admitted is consistent.
  const close = async (): Promise<void> => {
    for (;;) {
      for (const [p, kind] of changed) {
        if (kind === 'deleted' || outcomes.has(p)) continue;
        const file = await locate(p);
        const outcome: FileOutcome = file ? await extractFile(file, pool) : { kind: 'unreadable' };
        outcomes.set(p, outcome);
        // Gone or unreadable since detection: its row is dropped like a deletion, so rule 4
        // (importers of neighbouring paths) must see it as one.
        if (outcome.kind === 'unreadable' && kind === 'modified') changed.set(p, 'deleted');
      }
      let grew = false;
      for (const dep of findDependents(q, changed, outcomes, rows)) {
        if (dependents.has(dep)) continue;
        const kind = pending.get(dep);
        if (kind !== undefined) {
          changed.set(dep, kind);
          grew = true;
          continue;
        }
        const file = await locate(dep);
        if (!file) {
          changed.set(dep, 'deleted');
          grew = true;
          continue;
        }
        const outcome = await extractFile(file, pool);
        if (outcome.kind !== 'ok' || outcome.row.contentHash !== rows.get(dep)?.contentHash) {
          // Changed on disk but outside this call's scope: apply it now rather than resolve stale refs.
          changed.set(dep, outcome.kind === 'unreadable' ? 'deleted' : 'modified');
          outcomes.set(dep, outcome);
          grew = true;
          continue;
        }
        dependents.set(dep, outcome);
      }
      if (!grew) return;
    }
  };

  const ordered = [...pending.keys()].sort();
  const cap = maxFiles === undefined ? ordered.length : Math.max(1, maxFiles);
  let admitted = 0;
  for (const p of ordered) {
    if (admitted >= cap || (admitted > 0 && !timeLeft())) break;
    admitted++;
    if (changed.has(p)) continue;
    changed.set(p, pending.get(p) ?? 'modified');
    await close();
  }
  for (const p of changed.keys()) dependents.delete(p);
  return {
    changed,
    outcomes,
    dependents,
    touched: changes.touched,
    truncated: ordered.some((p) => !changed.has(p)),
  };
}

/**
 * Files whose resolved or failed refs could resolve differently once `changed` is applied:
 * (1) owners of edges into the changed files' nodes; (2) files with failed refs whose name tail
 * is a name, stem or directory the changed files had or now have; (3) owners of edges into
 * same-named symbols elsewhere (or their members), whose uniqueness may have changed;
 * (4) for ADDED or DELETED paths only, importers of files next to them. Which file an import
 * spec lands on depends only on the set of indexed paths (and on the configs, which force a
 * full index), so an edit in place never moves an import; an added or deleted path can, and
 * the resolvers search beyond the directory: TS `x.ts` vs `x/index.ts`, Go/Java packages by
 * directory, Java FQNs and Python roots by path suffix, tsconfig `paths` fallbacks to any
 * folder. Hence same directory, the `x/` subtree, and the same stem anywhere.
 */
function findDependents(
  q: GraphQueries,
  changed: Map<string, ChangeKind>,
  outcomes: Map<string, FileOutcome>,
  rows: ReadonlyMap<string, FileRow>,
): Set<string> {
  const paths = [...changed.keys()];
  const oldNodes = q.nodeRefsInFiles(paths.filter((p) => rows.has(p)));
  const names = new Set<string>();
  for (const n of oldNodes) if (n.kind !== 'file') names.add(n.name);
  for (const o of outcomes.values())
    if (o.kind === 'ok') for (const n of o.extraction.nodes) if (n.kind !== 'file') names.add(n.name);
  for (const p of paths) {
    names.add(fileStem(p));
    const dir = path.posix.basename(path.posix.dirname(p));
    if (dir && dir !== '.') names.add(dir);
  }

  const deps = q.referencingFiles(oldNodes.map((n) => n.id));
  for (const r of q.failedByNameTails([...names])) deps.add(r.filePath);

  let frontier = q
    .nodeRefsByNames([...names])
    .filter((n) => n.kind !== 'file' && !changed.has(n.filePath))
    .map((n) => n.id);
  const members = new Set(frontier);
  while (frontier.length > 0) {
    frontier = q
      .edgesFromMany(frontier, ['contains'])
      .map((e) => e.target)
      .filter((id) => !members.has(id));
    for (const id of frontier) members.add(id);
  }
  for (const f of q.referencingFiles([...members])) deps.add(f);

  const moved = paths.filter((p) => changed.get(p) !== 'modified');
  if (moved.length > 0) {
    const near = new Set<string>();
    for (const p of moved) {
      const dir = path.posix.dirname(p);
      const stem = fileStem(p);
      const nested = dir === '.' ? stem : `${dir}/${stem}`;
      for (const f of rows.keys()) {
        const fdir = path.posix.dirname(f);
        if (fdir === dir || fdir === nested || fdir.startsWith(`${nested}/`) || fileStem(f) === stem) near.add(f);
      }
    }
    for (const f of q.referencingFiles([...near].map((f) => makeNodeId(f, 'file', f, 1)))) deps.add(f);
  }

  for (const p of paths) deps.delete(p);
  return deps;
}

function applyPlan(db: GraphDb, q: GraphQueries, root: string, plan: SyncPlan): void {
  const { changed, outcomes, dependents } = plan;
  const touched = plan.touched.filter((t) => !changed.has(t.path));
  if (changed.size === 0 && touched.length === 0) return;
  const depPaths = [...dependents.keys()];
  q.transaction(() => {
    for (const t of touched) q.setFileModifiedAt(t.path, t.modifiedAt);
    if (changed.size === 0) return;
    for (const p of changed.keys()) q.deleteFile(p);
    q.deleteEdgesOwnedBy(q.nodeRefsInFiles(depPaths).map((n) => n.id));
    q.deleteUnresolvedInFiles(depPaths);
    for (const outcome of dependents.values()) {
      q.insertEdges(outcome.extraction.edges);
      q.insertUnresolved(outcome.extraction.unresolved);
    }
    for (const [p, kind] of changed) {
      const outcome = outcomes.get(p);
      if (kind === 'deleted' || !outcome) continue;
      if (outcome.kind === 'ok') writeExtraction(db, q, outcome);
      else if (outcome.kind === 'failed') q.upsertFile(outcome.row);
    }
    // A struct's method set can span files, so a changed .go file may add or drop an edge
    // between two untouched files; the whole inferred set is rebuilt (cap included).
    if ([...changed.keys()].some((p) => p.endsWith('.go'))) q.deleteGoInferredImplements();
    const live = [...changed].filter(([, kind]) => kind !== 'deleted').map(([p]) => p);
    resolveGraph(q, root, [...live, ...depPaths]);
    q.setMeta('indexed_at', String(Date.now()));
    q.setMeta('languages', JSON.stringify(q.languageCounts()));
  });
}
