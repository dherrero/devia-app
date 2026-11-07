import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openGraphDb } from '../engine/db/connection';
import { GraphQueries } from '../engine/db/queries';
import { acquireWriterLock } from '../engine/db/writer-lock';
import { fullIndex, snapshotGraph } from '../engine/indexer/sync-test-support';
import type { SyncResult } from '../engine/indexer/sync';
import { CodeGraphStore } from '../infrastructure/code-graph-store';
import { CodeGraphUseCase } from './code-graph.use-case';
import { createWorktreeGraph } from './worktree-graph';

let deviaDir: string;
let base: string;
let worktree: string;
let store: CodeGraphStore;
let useCase: CodeGraphUseCase;

const A_TS = "import { b } from './b';\nexport function a(): number {\n  return b();\n}\n";
const B_TS = 'export function b(): number {\n  return 1;\n}\n';
const TSCONFIG = '{"compilerOptions":{"strict":true}}';

function writeProject(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.ts'), A_TS);
  fs.writeFileSync(path.join(root, 'b.ts'), B_TS);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), TSCONFIG);
}

function meta(project: string, key: string): string | undefined {
  const db = openGraphDb(store.dbPath(project), { readonly: true });
  try {
    return new GraphQueries(db).getMeta(key);
  } finally {
    db.close();
  }
}

async function buildBaseGraph(): Promise<void> {
  await fullIndex(base, store.dataDir(base));
  store.saveDoc(base, { createdAt: 10, indexedAt: 20, autoUpdate: false, agentAccess: false, builtAtCommit: 'abc' });
}

function make(deps: ConstructorParameters<typeof CodeGraphUseCase>[0] extends infer D ? Partial<D> : never = {}) {
  useCase = new CodeGraphUseCase({ store, headCommit: async () => 'head1', ...deps });
  return createWorktreeGraph({ store, useCase });
}

beforeEach(() => {
  deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wt-dev-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wt-work-'));
  base = path.join(work, 'base');
  worktree = path.join(work, 'wt');
  writeProject(base);
  writeProject(worktree);
  store = new CodeGraphStore(() => deviaDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(deviaDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(base), { recursive: true, force: true });
});

describe('seedWorktreeGraph', () => {
  it('copies the base graph, rewrites root and keeps the doc settings', async () => {
    await buildBaseGraph();
    const { seedWorktreeGraph } = make({ sync: async () => ({ added: 0, modified: 0, deleted: 0, skippedBusy: true, truncated: false, fullIndexRequired: false }) });
    const res = await seedWorktreeGraph({ baseProject: base, worktreePath: worktree });
    expect(res).toEqual({ seeded: true });
    expect(snapshotGraph(store.dataDir(worktree))).toEqual(snapshotGraph(store.dataDir(base)));
    expect(path.resolve(meta(worktree, 'root') ?? '')).toBe(path.resolve(worktree));
    expect(path.resolve(meta(base, 'root') ?? '')).toBe(path.resolve(base));
    const doc = store.loadDoc(worktree);
    expect(doc).toMatchObject({ indexedAt: 20, autoUpdate: false, agentAccess: false, builtAtCommit: 'abc' });
    expect(doc?.createdAt).toBeGreaterThan(10);
    expect(fs.readdirSync(store.dataDir(worktree)).filter((f) => f.includes('seed'))).toEqual([]);
  });

  it('first unchanged sync of the seeded graph does not ask for a full index', async () => {
    await buildBaseGraph();
    const { seedWorktreeGraph } = make({ sync: async () => ({ added: 0, modified: 0, deleted: 0, skippedBusy: true, truncated: false, fullIndexRequired: false }) });
    await seedWorktreeGraph({ baseProject: base, worktreePath: worktree });
    const real = new CodeGraphUseCase({ store, headCommit: async () => 'head1' });
    const r = await real.syncNow(worktree);
    expect(r).not.toHaveProperty('fullIndexRequired', true);
    expect(r).toMatchObject({ added: 0, modified: 0, deleted: 0 });
  });

  it('background sync reconciles a changed file; the base graph is untouched', async () => {
    await buildBaseGraph();
    const baseBefore = snapshotGraph(store.dataDir(base));
    fs.writeFileSync(path.join(worktree, 'b.ts'), B_TS + 'export function c(): number {\n  return 2;\n}\n');
    const { seedWorktreeGraph } = make();
    const syncSpy = vi.spyOn(useCase, 'syncNow');
    await seedWorktreeGraph({ baseProject: base, worktreePath: worktree });
    expect(syncSpy).toHaveBeenCalledWith(worktree);
    await vi.waitFor(() => {
      const names = snapshotGraph(store.dataDir(worktree)).nodes.join('\n');
      expect(names).toContain('"name":"c"');
    });
    await vi.waitFor(async () => expect((await useCase.status(worktree)).state).not.toBe('indexing'));
    expect(snapshotGraph(store.dataDir(base))).toEqual(baseBefore);
    expect(snapshotGraph(store.dataDir(worktree)).nodes).not.toEqual(baseBefore.nodes);
  });

  it('skips with no-base-graph when the base was never indexed', async () => {
    const { seedWorktreeGraph } = make();
    expect(await seedWorktreeGraph({ baseProject: base, worktreePath: worktree })).toEqual({ seeded: false, reason: 'no-base-graph' });
    expect(store.exists(worktree)).toBe(false);
  });

  it('skips with base-indexing while a live indexer lock exists', async () => {
    await buildBaseGraph();
    const lock = acquireWriterLock(store.dataDir(base), 'indexer');
    expect(lock).not.toBeNull();
    try {
      const { seedWorktreeGraph } = make();
      expect(await seedWorktreeGraph({ baseProject: base, worktreePath: worktree })).toEqual({ seeded: false, reason: 'base-indexing' });
      expect(store.exists(worktree)).toBe(false);
    } finally {
      lock?.release();
    }
  });

  it('is idempotent', async () => {
    await buildBaseGraph();
    const { seedWorktreeGraph } = make({ sync: async () => ({ added: 0, modified: 0, deleted: 0, skippedBusy: true, truncated: false, fullIndexRequired: false }) });
    await seedWorktreeGraph({ baseProject: base, worktreePath: worktree });
    expect(await seedWorktreeGraph({ baseProject: base, worktreePath: worktree })).toEqual({ seeded: false, reason: 'already-has-graph' });
  });

  it('reports copy-failed and leaves nothing behind when the base db is unreadable', async () => {
    await buildBaseGraph();
    fs.writeFileSync(store.dbPath(base), 'not a database'.repeat(100));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { seedWorktreeGraph } = make();
    expect(await seedWorktreeGraph({ baseProject: base, worktreePath: worktree })).toEqual({ seeded: false, reason: 'copy-failed' });
    expect(store.exists(worktree)).toBe(false);
    expect(fs.readdirSync(store.dataDir(worktree))).toEqual([]);
  });
});

describe('dropWorktreeGraph', () => {
  it('removes only the worktree graph and is a no-op when absent', async () => {
    await buildBaseGraph();
    const { seedWorktreeGraph, dropWorktreeGraph } = make({ sync: async () => ({ added: 0, modified: 0, deleted: 0, skippedBusy: true, truncated: false, fullIndexRequired: false }) });
    await seedWorktreeGraph({ baseProject: base, worktreePath: worktree });
    await dropWorktreeGraph(worktree);
    expect(fs.existsSync(store.dataDir(worktree))).toBe(false);
    expect(store.exists(base)).toBe(true);
    await expect(dropWorktreeGraph(worktree)).resolves.toBeUndefined();
  });

  it('waits for a running background sync', async () => {
    await buildBaseGraph();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sync = async (): Promise<SyncResult> => {
      await gate;
      return { added: 0, modified: 0, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: false };
    };
    const { seedWorktreeGraph, dropWorktreeGraph } = make({ sync });
    await seedWorktreeGraph({ baseProject: base, worktreePath: worktree });
    let dropped = false;
    const p = dropWorktreeGraph(worktree).then(() => (dropped = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(dropped).toBe(false);
    expect(store.exists(worktree)).toBe(true);
    release();
    await p;
    expect(fs.existsSync(store.dataDir(worktree))).toBe(false);
    expect(store.exists(base)).toBe(true);
  });

  it('swallows and logs errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { dropWorktreeGraph } = make();
    vi.spyOn(useCase, 'reset').mockRejectedValue(new Error('nope'));
    await expect(dropWorktreeGraph(worktree)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
