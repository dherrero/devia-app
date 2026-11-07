import type { CodeGraphLanguage, CodeGraphStatus, IndexProgress } from '../../../../shared/domain/code-graph';
import { openGraphDb } from '../engine/db/connection';
import { GraphQueries } from '../engine/db/queries';
import { isFullIndexRunning } from '../engine/db/writer-lock';
import { runIndexInWorker, type IndexRun, type RunIndexOptions } from '../engine/indexer/index-runner';
import { syncProject, type SyncOptions, type SyncResult } from '../engine/indexer/sync';
import { CodeGraphStore, type ProjectDoc } from '../infrastructure/code-graph-store';
import { gitHeadCommit } from '../infrastructure/git-head';

export interface CodeGraphUseCaseDeps {
  store: CodeGraphStore;
  runIndex?: (opts: Pick<RunIndexOptions, 'root' | 'dataDir' | 'onProgress'>) => IndexRun;
  sync?: (opts: SyncOptions) => Promise<SyncResult>;
  headCommit?: (projectAbs: string) => Promise<string | undefined>;
  now?: () => number;
}

export type SyncNowOptions = Pick<SyncOptions, 'maxFiles' | 'deadlineMs' | 'onlyPaths'>;
export type SyncNowResult = SyncResult | { fullIndexRequired: true } | { missing: true };

interface Job {
  kind: 'index' | 'sync';
  cancel(): void;
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class CodeGraphUseCase {
  private readonly jobs = new Map<string, Job>();
  private readonly configStale = new Set<string>();
  private readonly runIndex: NonNullable<CodeGraphUseCaseDeps['runIndex']>;
  private readonly sync: NonNullable<CodeGraphUseCaseDeps['sync']>;
  private readonly headCommit: NonNullable<CodeGraphUseCaseDeps['headCommit']>;
  private readonly now: () => number;
  private readonly store: CodeGraphStore;

  constructor(deps: CodeGraphUseCaseDeps) {
    this.store = deps.store;
    this.runIndex = deps.runIndex ?? runIndexInWorker;
    this.sync = deps.sync ?? syncProject;
    this.headCommit = deps.headCommit ?? gitHeadCommit;
    this.now = deps.now ?? Date.now;
  }

  async status(projectAbs: string): Promise<CodeGraphStatus> {
    const doc = this.store.loadDoc(projectAbs);
    const base: CodeGraphStatus = {
      state: 'none',
      nodeCount: 0,
      edgeCount: 0,
      fileCount: 0,
      languages: {},
      agentAccess: doc?.agentAccess !== false,
      autoUpdate: doc?.autoUpdate ?? true,
    };
    if (doc?.builtAtCommit !== undefined) base.builtAtCommit = doc.builtAtCommit;
    if (doc !== undefined) base.indexedAt = doc.indexedAt;

    const indexing = this.jobs.get(projectAbs)?.kind === 'index' || isFullIndexRunning(this.store.dataDir(projectAbs));
    if (!this.store.exists(projectAbs)) return indexing ? { ...base, state: 'indexing' } : base;

    const read = this.readGraph(projectAbs);
    if (indexing) return { ...base, ...(read ?? {}), state: 'indexing' };
    if (!read) return { ...base, state: 'error' };

    const out: CodeGraphStatus = { ...base, ...read, state: 'ready' };
    if (read.fileCount === 0) out.unsupported = true;
    if (this.configStale.has(projectAbs)) {
      out.state = 'stale';
      out.staleReason = 'config';
    } else if (doc?.builtAtCommit !== undefined) {
      const head = await this.headCommit(projectAbs);
      if (head !== undefined && head !== doc.builtAtCommit) {
        out.state = 'stale';
        out.staleReason = 'commit';
      }
    }
    return out;
  }

  async index(projectAbs: string, onProgress: (p: IndexProgress) => void): Promise<CodeGraphStatus> {
    if (this.jobs.has(projectAbs)) throw codedError('INDEX_BUSY', 'A code graph job is already running for this project');
    const run = this.runIndex({ root: projectAbs, dataDir: this.store.dataDir(projectAbs), onProgress });
    this.jobs.set(projectAbs, { kind: 'index', cancel: () => run.cancel() });
    try {
      await run.promise;
      const previous = this.store.loadDoc(projectAbs);
      const now = this.now();
      const head = await this.headCommit(projectAbs);
      const doc: ProjectDoc = {
        createdAt: previous?.createdAt ?? now,
        indexedAt: now,
        autoUpdate: previous?.autoUpdate ?? true,
      };
      if (previous?.agentAccess === false) doc.agentAccess = false;
      if (head !== undefined) doc.builtAtCommit = head;
      this.store.saveDoc(projectAbs, doc);
      this.configStale.delete(projectAbs);
    } finally {
      this.jobs.delete(projectAbs);
    }
    return this.status(projectAbs);
  }

  cancel(projectAbs: string): void {
    this.jobs.get(projectAbs)?.cancel();
  }

  reset(projectAbs: string): void {
    this.cancel(projectAbs);
    this.configStale.delete(projectAbs);
    this.store.remove(projectAbs);
  }

  setAgentAccess(projectAbs: string, enabled: boolean): void {
    const doc = this.requireDoc(projectAbs);
    const next: ProjectDoc = { ...doc };
    if (enabled) delete next.agentAccess;
    else next.agentAccess = false;
    this.store.saveDoc(projectAbs, next);
  }

  setAutoUpdate(projectAbs: string, enabled: boolean): void {
    this.store.saveDoc(projectAbs, { ...this.requireDoc(projectAbs), autoUpdate: enabled });
  }

  async syncNow(projectAbs: string, opts: SyncNowOptions = {}): Promise<SyncNowResult> {
    if (this.jobs.has(projectAbs)) {
      return { added: 0, modified: 0, deleted: 0, skippedBusy: true, truncated: false, fullIndexRequired: false };
    }
    this.jobs.set(projectAbs, { kind: 'sync', cancel: () => undefined });
    try {
      const syncOpts: SyncOptions = { root: projectAbs, dataDir: this.store.dataDir(projectAbs) };
      if (opts.maxFiles !== undefined) syncOpts.maxFiles = opts.maxFiles;
      if (opts.deadlineMs !== undefined) syncOpts.deadlineMs = opts.deadlineMs;
      if (opts.onlyPaths !== undefined) syncOpts.onlyPaths = opts.onlyPaths;
      const result = await this.sync(syncOpts);
      if (result.fullIndexRequired) {
        this.configStale.add(projectAbs);
        return { fullIndexRequired: true };
      }
      if (!result.skippedBusy && !result.truncated && opts.onlyPaths === undefined) await this.markSynced(projectAbs);
      return result;
    } catch (err) {
      if ((err as { code?: unknown }).code === 'GRAPH_NOT_FOUND') return { missing: true };
      throw err;
    } finally {
      this.jobs.delete(projectAbs);
    }
  }

  private async markSynced(projectAbs: string): Promise<void> {
    const doc = this.store.loadDoc(projectAbs);
    if (!doc) return;
    const head = await this.headCommit(projectAbs);
    const next: ProjectDoc = { ...doc, indexedAt: this.now() };
    if (head !== undefined) next.builtAtCommit = head;
    this.store.saveDoc(projectAbs, next);
  }

  private requireDoc(projectAbs: string): ProjectDoc {
    const doc = this.store.loadDoc(projectAbs);
    if (!doc || !this.store.exists(projectAbs)) {
      throw codedError('CODE_GRAPH_NOT_CREATED', 'The code graph has not been created for this project');
    }
    return doc;
  }

  private readGraph(
    projectAbs: string,
  ): Pick<CodeGraphStatus, 'nodeCount' | 'edgeCount' | 'fileCount' | 'languages'> | undefined {
    let db: ReturnType<typeof openGraphDb> | undefined;
    try {
      db = openGraphDb(this.store.dbPath(projectAbs), { readonly: true });
      const q = new GraphQueries(db);
      const c = q.counts();
      return {
        nodeCount: c.nodes,
        edgeCount: c.edges,
        fileCount: c.files,
        languages: parseLanguages(q.getMeta('languages')),
      };
    } catch {
      return undefined;
    } finally {
      try {
        db?.close();
      } catch {
        // already closed
      }
    }
  }
}

function parseLanguages(raw: string | undefined): Partial<Record<CodeGraphLanguage, number>> {
  if (raw === undefined) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Partial<Record<CodeGraphLanguage, number>>) : {};
  } catch {
    return {};
  }
}
