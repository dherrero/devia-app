import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openGraphDb, type GraphDb } from '../engine/db/connection';
import { GraphQueries } from '../engine/db/queries';
import type { IndexResult } from '../engine/indexer/orchestrator';
import type { IndexRun } from '../engine/indexer/index-runner';
import type { SyncResult } from '../engine/indexer/sync';
import { runIndexInWorker } from '../engine/indexer/index-runner';
import { CodeGraphStore } from '../infrastructure/code-graph-store';
import { CodeGraphUseCase, type CodeGraphUseCaseDeps } from './code-graph.use-case';

let deviaDir: string;
let store: CodeGraphStore;
const project = path.join(path.sep, 'work', 'my-app');

beforeEach(() => {
  deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-uc-'));
  store = new CodeGraphStore(() => deviaDir);
});
afterEach(() => {
  fs.rmSync(deviaDir, { recursive: true, force: true });
});

function writeGraph(dataDir: string, fileCount: number): IndexResult {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openGraphDb(path.join(dataDir, 'graph.db'));
  try {
    const q = new GraphQueries(db);
    for (let i = 0; i < fileCount; i++) {
      const p = `src/f${i}.ts`;
      q.upsertFile({
        path: p,
        contentHash: `h${i}`,
        language: 'typescript',
        size: 1,
        modifiedAt: 1,
        indexedAt: 1,
        nodeCount: 1,
        generated: false,
        isTest: false,
      });
      q.insertNodes([
        {
          id: `n${i}`,
          kind: 'function',
          name: `f${i}`,
          qualifiedName: `f${i}`,
          filePath: p,
          language: 'typescript',
          startLine: 1,
          endLine: 2,
          isExported: true,
        },
      ]);
    }
    q.setMeta('languages', JSON.stringify(fileCount > 0 ? { typescript: fileCount } : {}));
  } finally {
    db.close();
  }
  return { nodes: fileCount, edges: 0, files: fileCount, skipped: 0, skippedFiles: [], durationMs: 1, languages: {} };
}

interface Gate {
  promise: Promise<void>;
  open(): void;
}
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

function makeUseCase(over: Partial<CodeGraphUseCaseDeps> = {}, files = 2): { uc: CodeGraphUseCase; calls: { index: number; sync: number } } {
  const calls = { index: 0, sync: 0 };
  const deps: CodeGraphUseCaseDeps = {
    store,
    runIndex: (o): IndexRun => {
      calls.index++;
      return {
        promise: Promise.resolve().then(() => writeGraph(o.dataDir, files)),
        cancel: () => undefined,
      };
    },
    sync: async (): Promise<SyncResult> => {
      calls.sync++;
      return { added: 0, modified: 0, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: false };
    },
    headCommit: async () => undefined,
    now: () => 1000,
    ...over,
  };
  return { uc: new CodeGraphUseCase(deps), calls };
}

const noProgress = (): void => undefined;

describe('CodeGraphUseCase', () => {
  it('goes from none to ready with counts', async () => {
    const { uc } = makeUseCase();
    expect((await uc.status(project)).state).toBe('none');
    const st = await uc.index(project, noProgress);
    expect(st.state).toBe('ready');
    expect(st.nodeCount).toBe(2);
    expect(st.fileCount).toBe(2);
    expect(st.languages).toEqual({ typescript: 2 });
    expect(st.indexedAt).toBe(1000);
    expect(st.agentAccess).toBe(true);
    expect(st.autoUpdate).toBe(true);
  });

  it('rejects a concurrent index with INDEX_BUSY and reports indexing', async () => {
    const g = gate();
    const { uc } = makeUseCase({
      runIndex: (o) => ({
        promise: g.promise.then(() => writeGraph(o.dataDir, 1)),
        cancel: () => undefined,
      }),
    });
    const first = uc.index(project, noProgress);
    await expect(uc.index(project, noProgress)).rejects.toMatchObject({ code: 'INDEX_BUSY' });
    expect((await uc.status(project)).state).toBe('indexing');
    g.open();
    await first;
    expect((await uc.status(project)).state).toBe('ready');
  });

  it('cancel aborts the running index and leaves no graph', async () => {
    let reject!: (e: Error) => void;
    let cancelled = 0;
    const { uc } = makeUseCase({
      runIndex: () => ({
        promise: new Promise<IndexResult>((_r, rej) => {
          reject = rej;
        }),
        cancel: () => {
          cancelled++;
          reject(new DOMException('Index cancelled', 'AbortError'));
        },
      }),
    });
    const p = uc.index(project, noProgress);
    uc.cancel(project);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(1);
    expect((await uc.status(project)).state).toBe('none');
  });

  it('reset removes the graph and cancels a running job', async () => {
    const { uc } = makeUseCase();
    await uc.index(project, noProgress);
    await uc.reset(project);
    expect((await uc.status(project)).state).toBe('none');
    expect(fs.existsSync(store.dataDir(project))).toBe(false);
  });

  it('preserves autoUpdate, agentAccess and createdAt across re-index', async () => {
    let t = 1000;
    const { uc } = makeUseCase({ now: () => t });
    await uc.index(project, noProgress);
    uc.setAgentAccess(project, false);
    uc.setAutoUpdate(project, false);
    t = 2000;
    const st = await uc.index(project, noProgress);
    expect(st.agentAccess).toBe(false);
    expect(st.autoUpdate).toBe(false);
    const doc = store.loadDoc(project);
    expect(doc).toMatchObject({ createdAt: 1000, indexedAt: 2000, autoUpdate: false, agentAccess: false });
  });

  it('setAgentAccess(true) omits the flag from the doc', async () => {
    const { uc } = makeUseCase();
    await uc.index(project, noProgress);
    uc.setAgentAccess(project, false);
    expect(store.loadDoc(project)?.agentAccess).toBe(false);
    uc.setAgentAccess(project, true);
    expect(store.loadDoc(project)?.agentAccess).toBeUndefined();
  });

  it('setters throw CODE_GRAPH_NOT_CREATED without a graph', () => {
    const { uc } = makeUseCase();
    expect(() => uc.setAgentAccess(project, false)).toThrow(expect.objectContaining({ code: 'CODE_GRAPH_NOT_CREATED' }));
    expect(() => uc.setAutoUpdate(project, false)).toThrow(expect.objectContaining({ code: 'CODE_GRAPH_NOT_CREATED' }));
  });

  it('is stale when HEAD differs from the built commit', async () => {
    let head: string | undefined = 'aaa';
    const { uc } = makeUseCase({ headCommit: async () => head });
    const built = await uc.index(project, noProgress);
    expect(built.state).toBe('ready');
    expect(built.builtAtCommit).toBe('aaa');
    head = 'bbb';
    const st = await uc.status(project);
    expect(st.state).toBe('stale');
    expect(st.staleReason).toBe('commit');
  });

  it('is not stale when git is unavailable', async () => {
    let head: string | undefined = 'aaa';
    const { uc } = makeUseCase({ headCommit: async () => head });
    await uc.index(project, noProgress);
    head = undefined;
    expect((await uc.status(project)).state).toBe('ready');
  });

  it('surfaces fullIndexRequired and marks the status stale (config)', async () => {
    const { uc } = makeUseCase({
      sync: async () => ({ added: 0, modified: 0, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: true }),
    });
    await uc.index(project, noProgress);
    expect(await uc.syncNow(project)).toEqual({ fullIndexRequired: true });
    const st = await uc.status(project);
    expect(st.state).toBe('stale');
    expect(st.staleReason).toBe('config');
    expect((await uc.index(project, noProgress)).state).toBe('ready');
  });

  it('returns { missing: true } on GRAPH_NOT_FOUND', async () => {
    const { uc } = makeUseCase({
      sync: async () => {
        throw Object.assign(new Error('nope'), { code: 'GRAPH_NOT_FOUND' });
      },
    });
    expect(await uc.syncNow(project)).toEqual({ missing: true });
  });

  it('passes sync options and returns the sync result', async () => {
    let seen: unknown;
    const { uc } = makeUseCase({
      sync: async (o) => {
        seen = o;
        return { added: 1, modified: 0, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: false };
      },
    });
    await uc.index(project, noProgress);
    const r = await uc.syncNow(project, { deadlineMs: 50 });
    expect(r).toMatchObject({ added: 1 });
    expect(seen).toMatchObject({ root: project, dataDir: store.dataDir(project), deadlineMs: 50 });
  });

  it('allows only one active job per project (sync blocks index)', async () => {
    const g = gate();
    const { uc } = makeUseCase({
      sync: async () => {
        await g.promise;
        return { added: 0, modified: 0, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: false };
      },
    });
    await uc.index(project, noProgress);
    const s = uc.syncNow(project);
    await expect(uc.index(project, noProgress)).rejects.toMatchObject({ code: 'INDEX_BUSY' });
    g.open();
    await s;
  });

  it('status closes the DB handle on the success path', async () => {
    const closes: number[] = [];
    const { uc } = makeUseCase({
      openDb: (file, o) => {
        const db = openGraphDb(file, o);
        const close = db.close.bind(db);
        db.close = (): void => {
          closes.push(1);
          close();
        };
        return db;
      },
    });
    await uc.index(project, noProgress);
    closes.length = 0;
    expect((await uc.status(project)).state).toBe('ready');
    expect(closes).toHaveLength(1);
  });

  it('status closes the DB handle on the error path', async () => {
    const close = vi.fn();
    const { uc } = makeUseCase({
      openDb: () =>
        ({
          exec: () => undefined,
          prepare: () => {
            throw new Error('boom');
          },
          close,
        }) as unknown as GraphDb,
    });
    await uc.index(project, noProgress);
    close.mockClear();
    expect((await uc.status(project)).state).toBe('error');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports unsupported for a graph with 0 files', async () => {
    const { uc } = makeUseCase({}, 0);
    const st = await uc.index(project, noProgress);
    expect(st.unsupported).toBe(true);
    expect(st.fileCount).toBe(0);
  });

  it('reports error when the DB cannot be opened', async () => {
    const { uc } = makeUseCase();
    await uc.index(project, noProgress);
    fs.writeFileSync(store.dbPath(project), 'this is not a database'.repeat(100));
    expect((await uc.status(project)).state).toBe('error');
  });
});

describe('CodeGraphUseCase races and job lifecycle', () => {
  const okSync = async (): Promise<SyncResult> => ({
    added: 0,
    modified: 0,
    deleted: 0,
    skippedBusy: false,
    truncated: false,
    fullIndexRequired: false,
  });

  it('index does not overwrite a toggle made during the HEAD lookup', async () => {
    const g = gate();
    let slow = false;
    const { uc } = makeUseCase({
      headCommit: async () => {
        if (slow) await g.promise;
        return 'aaa';
      },
    });
    await uc.index(project, noProgress);
    slow = true;
    const second = uc.index(project, noProgress);
    await new Promise((r) => setTimeout(r, 10));
    uc.setAutoUpdate(project, false);
    uc.setAgentAccess(project, false);
    g.open();
    await second;
    expect(store.loadDoc(project)).toMatchObject({ autoUpdate: false, agentAccess: false });
  });

  it('markSynced does not overwrite a toggle made during the HEAD lookup', async () => {
    const g = gate();
    let slow = false;
    const { uc } = makeUseCase({
      sync: okSync,
      headCommit: async () => {
        if (slow) await g.promise;
        return 'aaa';
      },
    });
    await uc.index(project, noProgress);
    slow = true;
    const s = uc.syncNow(project);
    await new Promise((r) => setTimeout(r, 10));
    uc.setAutoUpdate(project, false);
    g.open();
    await s;
    expect(store.loadDoc(project)?.autoUpdate).toBe(false);
  });

  it('reset while indexing waits for the job and leaves nothing behind', async () => {
    const g = gate();
    const { uc } = makeUseCase({
      runIndex: (o) => ({
        promise: g.promise.then(() => writeGraph(o.dataDir, 1)),
        cancel: () => undefined,
      }),
    });
    const idx = uc.index(project, noProgress);
    const idxResult = idx.then(
      () => 'ok',
      (e: Error) => e.name,
    );
    let done = false;
    const rst = uc.reset(project).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    g.open();
    await rst;
    expect(await idxResult).toBe('AbortError');
    expect(fs.existsSync(store.dataDir(project))).toBe(false);
    expect((await uc.status(project)).state).toBe('none');
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(store.dataDir(project))).toBe(false);
  });

  it('an index requested during a reset runs after it, so the reset never deletes the new graph', async () => {
    const g = gate();
    let runs = 0;
    const { uc } = makeUseCase({
      runIndex: (o) => {
        runs++;
        const first = runs === 1;
        return {
          promise: (first ? g.promise : Promise.resolve()).then(() => writeGraph(o.dataDir, first ? 1 : 3)),
          cancel: () => undefined,
        };
      },
    });
    const idx = uc.index(project, noProgress).catch((e: Error) => e.name);
    const rst = uc.reset(project);
    expect(uc.reset(project)).toBe(rst);
    const again = uc.index(project, noProgress);
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(1);
    g.open();
    await rst;
    expect(await idx).toBe('AbortError');
    const st = await again;
    expect(runs).toBe(2);
    expect(st).toMatchObject({ state: 'ready', fileCount: 3 });
    expect(fs.existsSync(store.dbPath(project))).toBe(true);
    expect(store.loadDoc(project)).toBeDefined();
  });

  it('reset while syncing waits for the sync and does not recreate the doc', async () => {
    const g = gate();
    const { uc } = makeUseCase({
      sync: async () => {
        await g.promise;
        return okSync();
      },
    });
    await uc.index(project, noProgress);
    const s = uc.syncNow(project);
    let done = false;
    const rst = uc.reset(project).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    g.open();
    await rst;
    await s;
    expect(fs.existsSync(store.dataDir(project))).toBe(false);
  });

  it('markSynced refreshes commit and indexedAt only for complete full-tree syncs', async () => {
    let t = 1000;
    let head = 'aaa';
    let result: SyncResult = {
      added: 0, modified: 0, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: false,
    };
    const { uc } = makeUseCase({ sync: async () => result, headCommit: async () => head, now: () => t });
    await uc.index(project, noProgress);

    t = 2000;
    head = 'bbb';
    result = { ...result, truncated: true };
    await uc.syncNow(project);
    expect(store.loadDoc(project)).toMatchObject({ builtAtCommit: 'aaa', indexedAt: 1000 });

    result = { ...result, truncated: false, skippedBusy: true };
    await uc.syncNow(project);
    expect(store.loadDoc(project)).toMatchObject({ builtAtCommit: 'aaa', indexedAt: 1000 });

    result = { ...result, skippedBusy: false };
    await uc.syncNow(project, { onlyPaths: ['src/f0.ts'] });
    expect(store.loadDoc(project)).toMatchObject({ builtAtCommit: 'aaa', indexedAt: 1000 });

    await uc.syncNow(project);
    expect(store.loadDoc(project)).toMatchObject({ builtAtCommit: 'bbb', indexedAt: 2000 });
  });

  it('bumps updatedAt when an index finishes or a sync changes files, never on a no-op sync', async () => {
    let t = 1000;
    const none: SyncResult = {
      added: 0, modified: 0, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: false,
    };
    let result: SyncResult = none;
    const { uc } = makeUseCase({ sync: async () => result, now: () => t });
    expect((await uc.status(project)).updatedAt).toBeUndefined();

    await uc.index(project, noProgress);
    const afterIndex = (await uc.status(project)).updatedAt;
    expect(afterIndex).toBe(1000);

    await uc.syncNow(project, { onlyPaths: ['src/f0.ts'] });
    expect((await uc.status(project)).updatedAt).toBe(afterIndex);

    result = { ...none, modified: 1 };
    await uc.syncNow(project, { onlyPaths: ['src/f0.ts'] });
    const afterEdit = (await uc.status(project)).updatedAt ?? 0;
    expect(afterEdit).toBeGreaterThan(afterIndex ?? 0);

    result = { ...none, deleted: 1 };
    await uc.syncNow(project, { onlyPaths: ['src/f1.ts'] });
    const afterDelete = (await uc.status(project)).updatedAt ?? 0;
    expect(afterDelete).toBeGreaterThan(afterEdit);

    t = 5000;
    result = { ...none, added: 2 };
    await uc.syncNow(project);
    expect((await uc.status(project)).updatedAt).toBe(5000);

    result = none;
    await uc.syncNow(project);
    expect((await uc.status(project)).updatedAt).toBe(5000);
  });

  it('an active index makes syncNow return skippedBusy without calling sync', async () => {
    const g = gate();
    const { uc, calls } = makeUseCase({
      runIndex: (o) => ({
        promise: g.promise.then(() => writeGraph(o.dataDir, 1)),
        cancel: () => undefined,
      }),
    });
    const idx = uc.index(project, noProgress);
    expect(await uc.syncNow(project)).toMatchObject({ skippedBusy: true });
    expect(calls.sync).toBe(0);
    g.open();
    await idx;
  });

  it('forwards onProgress to runIndex', async () => {
    const seen: unknown[] = [];
    const { uc } = makeUseCase({
      runIndex: (o) => {
        o.onProgress({ phase: 'parse', filesDone: 1, filesTotal: 2, nodes: 0, edges: 0 });
        return { promise: Promise.resolve(writeGraph(o.dataDir, 1)), cancel: () => undefined };
      },
    });
    await uc.index(project, (p) => seen.push(p));
    expect(seen).toEqual([{ phase: 'parse', filesDone: 1, filesTotal: 2, nodes: 0, edges: 0 }]);
  });
});

describe('CodeGraphUseCase end-to-end (real worker)', () => {
  it('indexes a tiny TS project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-e2e-root-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), "import { b } from './b';\nexport function a(): number { return b(); }\n");
      fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export function b(): number { return 1; }\n');
      const workerEntry = path.join(__dirname, '..', 'engine', 'indexer', '__fixtures__', 'ts-worker-shim.cjs');
      const uc = new CodeGraphUseCase({
        store,
        runIndex: (o) => runIndexInWorker({ ...o, workerEntry }),
        headCommit: async () => undefined,
      });
      const st = await uc.index(root, noProgress);
      expect(st.state).toBe('ready');
      expect(st.nodeCount).toBeGreaterThan(0);
      expect(st.fileCount).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
