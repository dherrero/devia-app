import * as fs from 'node:fs';
import * as path from 'node:path';
import { openGraphDb, type GraphDb } from '../db/connection';
import { GraphQueries, type FileRow } from '../db/queries';
import { acquireWriterLock } from '../db/writer-lock';
import { discoverFiles, discoverPaths, toProjectPath, type DiscoveredFile } from '../discovery/discover';
import { makeNodeId } from '../extraction/node-id';
import { fileStem, resolveReferences } from '../resolution/resolver';
import { detectChanges } from './change-detection';
import { extractFile, isSupported, ParserPool, writeExtraction, type FileOutcome } from './extract-file';
import { GRAPH_DB_FILE } from './orchestrator';

// Adapted from codegraph (MIT), src/sync/ and the `sync` entry point of src/index.ts.

export interface SyncOptions {
  root: string;
  dataDir: string;
  /** Changed files applied per call; the rest is picked up by the next sync. */
  maxFiles?: number;
  /** Time budget; when it runs out before the write phase nothing is written. */
  deadlineMs?: number;
  /** Look only at these paths (relative to the root, or absolute inside it). */
  onlyPaths?: string[];
}

export interface SyncResult {
  added: number;
  modified: number;
  deleted: number;
  skippedBusy: boolean;
  truncated: boolean;
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

const EMPTY: SyncResult = { added: 0, modified: 0, deleted: 0, skippedBusy: false, truncated: false };

class DeadlineExceeded extends Error {}

/**
 * Brings graph.db up to date with the tree, giving exactly the graph a full reindex would.
 * Resolved refs are deleted from `unresolved_refs`, so every file whose resolution could
 * change ("dependents") is re-extracted and resolved again together with the changed files.
 * Reading and parsing happen first; all writes then go in one transaction, so a deadline,
 * a crash or an exception leaves the previous consistent graph.
 */
export async function syncProject(opts: SyncOptions): Promise<SyncResult> {
  const { root, dataDir } = opts;
  const dbPath = path.join(dataDir, GRAPH_DB_FILE);
  if (!fs.existsSync(dbPath)) throw new GraphNotFoundError(dataDir);
  const lock = acquireWriterLock(dataDir, 'sync');
  if (!lock) return { ...EMPTY, skippedBusy: true };

  const started = Date.now();
  const checkDeadline = (): void => {
    if (opts.deadlineMs !== undefined && Date.now() - started >= opts.deadlineMs) throw new DeadlineExceeded();
  };
  const pool = new ParserPool();
  let db: GraphDb | undefined;
  try {
    if (!fs.existsSync(dbPath)) throw new GraphNotFoundError(dataDir);
    db = openGraphDb(dbPath);
    const q = new GraphQueries(db);
    const plan = await planSync(q, opts, pool, checkDeadline);
    if (!plan) return EMPTY;
    checkDeadline();
    applyPlan(db, q, root, plan);
    const count = (kind: ChangeKind): number => [...plan.changed.values()].filter((k) => k === kind).length;
    return {
      added: count('added'),
      modified: count('modified'),
      deleted: count('deleted'),
      skippedBusy: false,
      truncated: plan.capped,
    };
  } catch (err) {
    if (err instanceof DeadlineExceeded) return { ...EMPTY, truncated: true };
    throw err;
  } finally {
    await pool.dispose();
    db?.close();
    lock.release();
  }
}

interface SyncPlan {
  changed: Map<string, ChangeKind>;
  outcomes: Map<string, FileOutcome>;
  dependents: Map<string, OkOutcome>;
  touched: { path: string; modifiedAt: number }[];
  capped: boolean;
}

async function planSync(
  q: GraphQueries,
  opts: SyncOptions,
  pool: ParserPool,
  checkDeadline: () => void,
): Promise<SyncPlan | undefined> {
  const { root } = opts;
  const scope = opts.onlyPaths
    ? new Set(opts.onlyPaths.map((p) => toProjectPath(root, p)).filter((p): p is string => p !== undefined))
    : undefined;
  const discovered = scope
    ? await discoverPaths(root, [...scope], { isSupported })
    : await discoverFiles(root, { isSupported });
  const changes = detectChanges(q, discovered.files);
  if (scope) changes.deleted = changes.deleted.filter((p) => scope.has(p));
  checkDeadline();

  const pending = new Map<string, ChangeKind>();
  for (const p of changes.deleted) pending.set(p, 'deleted');
  for (const p of changes.added) pending.set(p, 'added');
  for (const p of changes.modified) pending.set(p, 'modified');
  if (pending.size === 0 && changes.touched.length === 0) return undefined;

  const ordered = [...pending.keys()].sort();
  const cap = opts.maxFiles === undefined ? ordered.length : Math.max(1, opts.maxFiles);
  const changed = new Map<string, ChangeKind>();
  for (const p of ordered.slice(0, cap)) changed.set(p, pending.get(p) ?? 'modified');

  const byPath = new Map(discovered.files.map((f) => [f.relPath, f]));
  const rows = new Map(q.fileRecords().map((r) => [r.path, r]));
  const outcomes = new Map<string, FileOutcome>();
  const dependents = new Map<string, OkOutcome>();

  const locate = async (rel: string): Promise<DiscoveredFile | undefined> =>
    byPath.get(rel) ?? (scope ? (await discoverPaths(root, [rel], { isSupported })).files[0] : undefined);

  for (;;) {
    for (const [p, kind] of changed) {
      if (kind === 'deleted' || outcomes.has(p)) continue;
      checkDeadline();
      const file = await locate(p);
      outcomes.set(p, file ? await extractFile(file, pool) : { kind: 'unreadable' });
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
      checkDeadline();
      const file = await locate(dep);
      if (!file) {
        changed.set(dep, 'deleted');
        grew = true;
        continue;
      }
      const outcome = await extractFile(file, pool);
      if (outcome.kind !== 'ok' || outcome.row.contentHash !== rows.get(dep)?.contentHash) {
        // Changed on disk but outside this call's scope: apply it now rather than resolve stale refs.
        changed.set(dep, 'modified');
        outcomes.set(dep, outcome);
        grew = true;
        continue;
      }
      dependents.set(dep, outcome);
    }
    if (!grew) break;
  }
  for (const p of changed.keys()) dependents.delete(p);
  return { changed, outcomes, dependents, touched: changes.touched, capped: ordered.length > cap };
}

/**
 * Files whose resolved or failed refs could resolve differently once `changed` is applied:
 * (1) owners of edges into the changed files' nodes; (2) files with failed refs whose name tail
 * is a name, stem or directory the changed files had or now have; (3) owners of edges into
 * same-named symbols elsewhere (or their members), whose uniqueness may have changed;
 * (4) importers of files that sit next to a changed path (same directory, `x/` for `x.ts`,
 * same stem), whose import resolution may now pick another file.
 */
function findDependents(
  q: GraphQueries,
  changed: Map<string, ChangeKind>,
  outcomes: Map<string, FileOutcome>,
  rows: Map<string, FileRow>,
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

  const isChanged = (p: string): boolean => changed.has(p);
  let frontier = q
    .nodeRefsByNames([...names])
    .filter((n) => n.kind !== 'file' && !isChanged(n.filePath))
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

  const near = new Set<string>();
  for (const p of paths) {
    const dir = path.posix.dirname(p);
    const stem = fileStem(p);
    const nested = dir === '.' ? stem : `${dir}/${stem}`;
    for (const f of rows.keys()) {
      const fdir = path.posix.dirname(f);
      if (fdir === dir || fdir === nested || fdir.startsWith(`${nested}/`) || fileStem(f) === stem) near.add(f);
    }
  }
  for (const f of q.referencingFiles([...near].map((f) => makeNodeId(f, 'file', f, 1)))) deps.add(f);

  for (const p of paths) deps.delete(p);
  return deps;
}

function applyPlan(db: GraphDb, q: GraphQueries, root: string, plan: SyncPlan): void {
  const { changed, outcomes, dependents } = plan;
  const depPaths = [...dependents.keys()];
  q.transaction(() => {
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
    for (const t of plan.touched) if (!changed.has(t.path)) q.setFileModifiedAt(t.path, t.modifiedAt);
    if (changed.size === 0) return;
    const live = [...changed].filter(([, kind]) => kind !== 'deleted').map(([p]) => p);
    resolveReferences(q, root, [...live, ...depPaths]);
    q.setMeta('indexed_at', String(Date.now()));
    q.setMeta('languages', JSON.stringify(q.languageCounts()));
  });
}
