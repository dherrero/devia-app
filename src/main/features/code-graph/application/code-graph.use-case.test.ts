import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openGraphDb } from '../engine/db/connection';
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
  return { nodes: fileCount, edges: 0, files: fileCount, skipped: 0, durationMs: 1, languages: {} };
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
    uc.reset(project);
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

  it.skipIf(process.platform === 'win32')('status leaves no open DB handle', async () => {
    const { uc } = makeUseCase();
    await uc.index(project, noProgress);
    await uc.status(project);
    const db = store.dbPath(project);
    fs.renameSync(db, `${db}.moved`);
    for (const ext of ['-wal', '-shm']) fs.rmSync(`${db}${ext}`, { force: true });
    expect(fs.existsSync(db)).toBe(false);
    expect((await uc.status(project)).state).toBe('none');
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
