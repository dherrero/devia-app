import type { CodeGraphLanguage, CodeGraphStatus, IndexProgress } from '../../../../shared/domain/code-graph';
import { openGraphDb } from '../engine/db/connection';
import { GraphQueries } from '../engine/db/queries';
import { isFullIndexRunning } from '../engine/db/writer-lock';
import { runIndexInWorker, type IndexRun, type RunIndexOptions } from '../engine/indexer/index-runner';
import { syncProject, type SyncOptions, type SyncResult } from '../engine/indexer/sync';
import { isSupported } from '../engine/indexer/extract-file';
import { isResolutionConfig } from '../engine/indexer/resolution-config';
import { CodeGraphStore, type ProjectDoc } from '../infrastructure/code-graph-store';
import { createFileWatcher, type WatcherHandle } from '../infrastructure/file-watcher';
import { gitHeadCommit } from '../infrastructure/git-head';
import { computeStaleness } from '../infrastructure/staleness';

export interface CodeGraphUseCaseDeps {
  store: CodeGraphStore;
  runIndex?: (opts: Pick<RunIndexOptions, 'root' | 'dataDir' | 'onProgress'>) => IndexRun;
  sync?: (opts: SyncOptions) => Promise<SyncResult>;
  headCommit?: (projectAbs: string) => Promise<string | undefined>;
  now?: () => number;
  openDb?: typeof openGraphDb;
  createWatcher?: (
    root: string,
    isRelevant: (rel: string) => boolean,
    onChange: (rels: string[], overflow: boolean) => void,
    opts?: { onError?: (err: unknown) => void },
  ) => WatcherHandle;
  /** How often a watched project's HEAD commit is compared with the one the graph was built at. */
  pollIntervalMs?: number;
}

export type SyncNowOptions = Pick<SyncOptions, 'maxFiles' | 'deadlineMs' | 'onlyPaths'>;
export type SyncNowResult = SyncResult | { fullIndexRequired: true } | { missing: true };

export const DEFAULT_AUTO_UPDATE = true;
export const MAX_WATCHED_PROJECTS = 5;
export const HEAD_POLL_MS = 20_000;

interface WatchEntry {
  projectAbs: string;
  listeners: Set<(s: CodeGraphStatus) => void>;
  watcher: WatcherHandle;
  poll: ReturnType<typeof setInterval>;
  closed: boolean;
  pending: Set<string>;
  overflow: boolean;
  draining: boolean;
  polling: boolean;
  dirty: number;
  lastHeadHandled: string | undefined;
}

const isRelevantPath = (rel: string): boolean => isSupported(rel) || isResolutionConfig(rel);

interface Job {
  kind: 'index' | 'sync';
  cancel(): void;
  /** Set by cancel/reset: the job must not write the doc any more. */
  stopped: boolean;
  settled: Promise<void>;
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class CodeGraphUseCase {
  private readonly jobs = new Map<string, Job>();
  private readonly jobEnd = new WeakMap<Job, () => void>();
  private readonly configStale = new Set<string>();
  private readonly runIndex: NonNullable<CodeGraphUseCaseDeps['runIndex']>;
  private readonly sync: NonNullable<CodeGraphUseCaseDeps['sync']>;
  private readonly headCommit: NonNullable<CodeGraphUseCaseDeps['headCommit']>;
  private readonly now: () => number;
  private readonly openDb: typeof openGraphDb;
  private readonly store: CodeGraphStore;
  private readonly watches = new Map<string, WatchEntry>();
  private readonly createWatcher: NonNullable<CodeGraphUseCaseDeps['createWatcher']>;
  private readonly pollIntervalMs: number;

  constructor(deps: CodeGraphUseCaseDeps) {
    this.store = deps.store;
    this.runIndex = deps.runIndex ?? runIndexInWorker;
    this.sync = deps.sync ?? syncProject;
    this.headCommit = deps.headCommit ?? gitHeadCommit;
    this.now = deps.now ?? Date.now;
    this.openDb = deps.openDb ?? openGraphDb;
    this.createWatcher = deps.createWatcher ?? createFileWatcher;
    this.pollIntervalMs = deps.pollIntervalMs ?? HEAD_POLL_MS;
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
      autoUpdate: doc?.autoUpdate ?? DEFAULT_AUTO_UPDATE,
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
    const autoUpdate = out.autoUpdate;
    const builtAt = doc?.builtAtCommit;
    const head = builtAt !== undefined && !this.configStale.has(projectAbs) ? await this.headCommit(projectAbs) : undefined;
    const staleness = computeStaleness({
      builtAtCommit: builtAt,
      headCommit: head,
      dirtyFiles: autoUpdate ? 0 : (this.watches.get(projectAbs)?.dirty ?? 0),
      configChanged: this.configStale.has(projectAbs),
    });
    if (staleness.stale && staleness.reason !== null) {
      out.state = 'stale';
      out.staleReason = staleness.reason;
    }
    return out;
  }

  async index(projectAbs: string, onProgress: (p: IndexProgress) => void): Promise<CodeGraphStatus> {
    if (this.jobs.has(projectAbs)) throw codedError('INDEX_BUSY', 'A code graph job is already running for this project');
    const run = this.runIndex({ root: projectAbs, dataDir: this.store.dataDir(projectAbs), onProgress });
    const job = this.startJob(projectAbs, 'index', () => run.cancel());
    const watch = this.watches.get(projectAbs);
    if (watch) {
      watch.pending.clear();
      watch.overflow = false;
    }
    try {
      await run.promise;
      if (job.stopped) throw new DOMException('Index cancelled', 'AbortError');
      const head = await this.headCommit(projectAbs);
      if (job.stopped) throw new DOMException('Index cancelled', 'AbortError');
      const previous = this.store.loadDoc(projectAbs);
      const now = this.now();
      const doc: ProjectDoc = {
        createdAt: previous?.createdAt ?? now,
        indexedAt: now,
        autoUpdate: previous?.autoUpdate ?? DEFAULT_AUTO_UPDATE,
      };
      if (previous?.agentAccess === false) doc.agentAccess = false;
      if (head !== undefined) doc.builtAtCommit = head;
      this.store.saveDoc(projectAbs, doc);
      this.configStale.delete(projectAbs);
      this.resetDirty(projectAbs);
    } finally {
      this.endJob(projectAbs, job);
    }
    this.reconcileAfterIndex(projectAbs);
    return this.status(projectAbs);
  }

  cancel(projectAbs: string): void {
    const job = this.jobs.get(projectAbs);
    if (!job) return;
    job.stopped = true;
    job.cancel();
  }

  async reset(projectAbs: string): Promise<void> {
    const job = this.jobs.get(projectAbs);
    this.cancel(projectAbs);
    const watch = this.watches.get(projectAbs);
    if (watch) this.closeWatch(watch);
    if (job) await job.settled;
    this.configStale.delete(projectAbs);
    this.store.remove(projectAbs);
  }

  private startJob(projectAbs: string, kind: Job['kind'], cancel: () => void): Job {
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job: Job = { kind, cancel, stopped: false, settled };
    this.jobEnd.set(job, release);
    this.jobs.set(projectAbs, job);
    return job;
  }

  private endJob(projectAbs: string, job: Job): void {
    if (this.jobs.get(projectAbs) === job) this.jobs.delete(projectAbs);
    this.jobEnd.get(job)?.();
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
    const watch = this.watches.get(projectAbs);
    if (enabled && watch && watch.dirty > 0) {
      watch.dirty = 0;
      this.enqueue(watch, [], true);
    }
  }

  /**
   * Starts (or joins) the file watcher of a project and reports status changes to `listener`.
   * The watcher lives only while at least one caller has not stopped.
   */
  watch(projectAbs: string, listener: (s: CodeGraphStatus) => void): { stop(): void } {
    let entry = this.watches.get(projectAbs);
    if (!entry) {
      if (this.watches.size >= MAX_WATCHED_PROJECTS) {
        throw codedError('CODE_GRAPH_WATCH_LIMIT', `At most ${MAX_WATCHED_PROJECTS} projects can be watched at once`);
      }
      entry = this.openWatch(projectAbs);
    }
    const watch = entry;
    const own = (st: CodeGraphStatus): void => listener(st);
    watch.listeners.add(own);
    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        watch.listeners.delete(own);
        if (watch.listeners.size === 0) this.closeWatch(watch);
      },
    };
  }

  private openWatch(projectAbs: string): WatchEntry {
    const entry: WatchEntry = {
      projectAbs,
      listeners: new Set(),
      watcher: { close: () => undefined },
      poll: undefined as unknown as ReturnType<typeof setInterval>,
      closed: false,
      pending: new Set(),
      overflow: false,
      draining: false,
      polling: false,
      dirty: 0,
      lastHeadHandled: undefined,
    };
    entry.watcher = this.createWatcher(
      projectAbs,
      isRelevantPath,
      (rels, overflow) => this.onChange(entry, rels, overflow),
      { onError: () => undefined },
    );
    entry.poll = setInterval(() => void this.pollHead(entry), this.pollIntervalMs);
    entry.poll.unref();
    this.watches.set(projectAbs, entry);
    return entry;
  }

  private closeWatch(entry: WatchEntry): void {
    if (entry.closed) return;
    entry.closed = true;
    clearInterval(entry.poll);
    entry.watcher.close();
    entry.pending.clear();
    entry.listeners.clear();
    if (this.watches.get(entry.projectAbs) === entry) this.watches.delete(entry.projectAbs);
  }

  private emit(entry: WatchEntry, status: CodeGraphStatus): void {
    if (entry.closed) return;
    for (const l of [...entry.listeners]) {
      try {
        l(status);
      } catch {
        // a faulty listener must not break the others
      }
    }
  }

  private isIndexing(projectAbs: string): boolean {
    return this.jobs.get(projectAbs)?.kind === 'index' || isFullIndexRunning(this.store.dataDir(projectAbs));
  }

  private onChange(entry: WatchEntry, rels: string[], overflow: boolean): void {
    if (entry.closed || this.isIndexing(entry.projectAbs)) return;
    if (!this.store.exists(entry.projectAbs)) return;
    const doc = this.store.loadDoc(entry.projectAbs);
    if (doc?.autoUpdate ?? DEFAULT_AUTO_UPDATE) {
      this.enqueue(entry, rels, overflow);
      return;
    }
    entry.dirty += overflow ? 1 : rels.length;
    void this.status(entry.projectAbs).then(
      (s) => this.emit(entry, s),
      () => undefined,
    );
  }

  private enqueue(entry: WatchEntry, rels: string[], overflow: boolean): void {
    if (entry.closed) return;
    if (overflow) entry.overflow = true;
    for (const r of rels) entry.pending.add(r);
    if (!entry.draining) void this.drain(entry);
  }

  private async drain(entry: WatchEntry): Promise<void> {
    entry.draining = true;
    try {
      while (!entry.closed && (entry.overflow || entry.pending.size > 0)) {
        const paths = [...entry.pending];
        const full = entry.overflow;
        entry.pending.clear();
        entry.overflow = false;
        const p = entry.projectAbs;
        if (this.configStale.has(p) || this.isIndexing(p) || !this.store.exists(p)) continue;
        let failed = false;
        try {
          const result = await this.syncNow(p, full ? {} : { onlyPaths: paths });
          if ('skippedBusy' in result && result.skippedBusy) continue;
        } catch {
          failed = true;
        }
        if (entry.closed) return;
        const status = await this.status(p);
        this.emit(entry, failed ? { ...status, state: 'error' } : status);
        if (failed) {
          entry.pending.clear();
          entry.overflow = false;
        }
      }
    } catch {
      entry.pending.clear();
      entry.overflow = false;
    } finally {
      entry.draining = false;
    }
  }

  private async pollHead(entry: WatchEntry): Promise<void> {
    if (entry.closed || entry.polling || entry.draining) return;
    const p = entry.projectAbs;
    if (this.isIndexing(p) || this.configStale.has(p)) return;
    entry.polling = true;
    try {
      const head = await this.headCommit(p);
      const built = this.store.loadDoc(p)?.builtAtCommit;
      if (entry.closed || head === undefined || built === undefined || head === built) return;
      if (head === entry.lastHeadHandled) return;
      entry.lastHeadHandled = head;
      this.emit(entry, await this.status(p));
      if (this.store.loadDoc(p)?.autoUpdate ?? DEFAULT_AUTO_UPDATE) this.enqueue(entry, [], true);
    } catch {
      // the next tick retries
    } finally {
      entry.polling = false;
    }
  }

  private reconcileAfterIndex(projectAbs: string): void {
    const entry = this.watches.get(projectAbs);
    if (!entry || entry.closed) return;
    if (this.store.loadDoc(projectAbs)?.autoUpdate ?? DEFAULT_AUTO_UPDATE) this.enqueue(entry, [], true);
  }

  private resetDirty(projectAbs: string): void {
    const entry = this.watches.get(projectAbs);
    if (entry) entry.dirty = 0;
  }

  async syncNow(projectAbs: string, opts: SyncNowOptions = {}): Promise<SyncNowResult> {
    if (this.jobs.has(projectAbs)) {
      return { added: 0, modified: 0, deleted: 0, skippedBusy: true, truncated: false, fullIndexRequired: false };
    }
    const job = this.startJob(projectAbs, 'sync', () => undefined);
    try {
      const syncOpts: SyncOptions = { root: projectAbs, dataDir: this.store.dataDir(projectAbs) };
      if (opts.maxFiles !== undefined) syncOpts.maxFiles = opts.maxFiles;
      if (opts.deadlineMs !== undefined) syncOpts.deadlineMs = opts.deadlineMs;
      if (opts.onlyPaths !== undefined) syncOpts.onlyPaths = opts.onlyPaths;
      const result = await this.sync(syncOpts);
      if (result.fullIndexRequired) {
        if (!job.stopped) this.configStale.add(projectAbs);
        return { fullIndexRequired: true };
      }
      if (!result.skippedBusy && !result.truncated && opts.onlyPaths === undefined) {
        await this.markSynced(projectAbs, job);
      }
      return result;
    } catch (err) {
      if ((err as { code?: unknown }).code === 'GRAPH_NOT_FOUND') return { missing: true };
      throw err;
    } finally {
      this.endJob(projectAbs, job);
    }
  }

  private async markSynced(projectAbs: string, job: Job): Promise<void> {
    const head = await this.headCommit(projectAbs);
    if (job.stopped) return;
    const doc = this.store.loadDoc(projectAbs);
    if (!doc) return;
    const next: ProjectDoc = { ...doc, indexedAt: this.now() };
    if (head !== undefined) next.builtAtCommit = head;
    this.store.saveDoc(projectAbs, next);
    this.resetDirty(projectAbs);
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
      db = this.openDb(this.store.dbPath(projectAbs), { readonly: true });
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
