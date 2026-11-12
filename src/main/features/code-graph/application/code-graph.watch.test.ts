import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CodeGraphStatus } from '../../../../shared/domain/code-graph';
import { openGraphDb } from '../engine/db/connection';
import { GraphQueries } from '../engine/db/queries';
import type { IndexRun } from '../engine/indexer/index-runner';
import type { SyncOptions, SyncResult } from '../engine/indexer/sync';
import { CodeGraphStore } from '../infrastructure/code-graph-store';
import { CodeGraphUseCase, type CodeGraphUseCaseDeps } from './code-graph.use-case';

let deviaDir: string;
let store: CodeGraphStore;
const project = path.join(path.sep, 'work', 'my-app');

beforeEach(() => {
  vi.useFakeTimers();
  deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-watch-'));
  store = new CodeGraphStore(() => deviaDir);
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(deviaDir, { recursive: true, force: true });
});

function writeGraph(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openGraphDb(path.join(dataDir, 'graph.db'));
  try {
    const q = new GraphQueries(db);
    q.upsertFile({
      path: 'src/a.ts',
      contentHash: 'h',
      language: 'typescript',
      size: 1,
      modifiedAt: 1,
      indexedAt: 1,
      nodeCount: 0,
      generated: false,
      isTest: false,
    });
    q.setMeta('languages', JSON.stringify({ typescript: 1 }));
  } finally {
    db.close();
  }
}

const OK: SyncResult = { added: 0, modified: 1, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: false };

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

interface FakeWatcher {
  root: string;
  closed: number;
  onChange: (rels: string[], overflow: boolean) => void;
  isRelevant: (rel: string) => boolean;
  opts: { onError?: (err: unknown) => void; onDegraded?: () => void } | undefined;
}

function setup(over: Partial<CodeGraphUseCaseDeps> = {}) {
  const watchers: FakeWatcher[] = [];
  const syncCalls: SyncOptions[] = [];
  const state = { running: 0, maxRunning: 0, head: undefined as string | undefined };
  const deps: CodeGraphUseCaseDeps = {
    store,
    runIndex: (o): IndexRun => ({
      promise: Promise.resolve().then(() => {
        writeGraph(o.dataDir);
        return { nodes: 0, edges: 0, files: 1, skipped: 0, skippedFiles: [], durationMs: 1, languages: {} };
      }),
      cancel: () => undefined,
    }),
    sync: async (o): Promise<SyncResult> => {
      syncCalls.push(o);
      state.running++;
      state.maxRunning = Math.max(state.maxRunning, state.running);
      await Promise.resolve();
      state.running--;
      return OK;
    },
    headCommit: async () => state.head,
    now: () => 1000,
    pollIntervalMs: 20_000,
    busyRetryMs: 500,
    createWatcher: (root, isRelevant, onChange, opts) => {
      const w: FakeWatcher = { root, closed: 0, onChange, isRelevant, opts };
      watchers.push(w);
      return {
        close: () => {
          w.closed++;
        },
      };
    },
    ...over,
  };
  const uc = new CodeGraphUseCase(deps);
  const statuses: CodeGraphStatus[] = [];
  const listener = (s: CodeGraphStatus): void => {
    statuses.push(s);
  };
  return { uc, watchers, syncCalls, state, statuses, listener };
}

async function indexed(env: ReturnType<typeof setup>): Promise<void> {
  await env.uc.index(project, () => undefined);
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe('CodeGraphUseCase.watch', () => {
  it('syncs only the changed paths with autoUpdate and emits the new status', async () => {
    const env = setup();
    await indexed(env);
    const h = env.uc.watch(project, env.listener);
    env.watchers[0]?.onChange(['src/a.ts'], false);
    await flush();
    expect(env.syncCalls).toHaveLength(1);
    expect(env.syncCalls[0]?.onlyPaths).toEqual(['src/a.ts']);
    expect(env.statuses.at(-1)?.state).toBe('ready');
    h.stop();
  });

  it('runs an unscoped sync on overflow', async () => {
    const env = setup();
    await indexed(env);
    const h = env.uc.watch(project, env.listener);
    env.watchers[0]?.onChange([], true);
    await flush();
    expect(env.syncCalls).toHaveLength(1);
    expect(env.syncCalls[0]?.onlyPaths).toBeUndefined();
    h.stop();
  });

  it('never runs two syncs at once and coalesces changes that arrive meanwhile', async () => {
    const g = gate();
    let first = true;
    const env = setup({
      sync: async (o) => {
        env.syncCalls.push(o);
        env.state.running++;
        env.state.maxRunning = Math.max(env.state.maxRunning, env.state.running);
        if (first) {
          first = false;
          await g.promise;
        }
        env.state.running--;
        return OK;
      },
    });
    await indexed(env);
    const h = env.uc.watch(project, env.listener);
    env.watchers[0]?.onChange(['a.ts'], false);
    await flush();
    env.watchers[0]?.onChange(['b.ts'], false);
    env.watchers[0]?.onChange(['c.ts', 'b.ts'], false);
    await flush();
    expect(env.syncCalls).toHaveLength(1);
    g.open();
    await flush();
    await flush();
    expect(env.syncCalls).toHaveLength(2);
    expect([...(env.syncCalls[1]?.onlyPaths ?? [])].sort()).toEqual(['b.ts', 'c.ts']);
    expect(env.state.maxRunning).toBe(1);
    h.stop();
  });

  it('marks stale dirty without syncing when autoUpdate is off', async () => {
    const env = setup();
    await indexed(env);
    env.uc.setAutoUpdate(project, false);
    const h = env.uc.watch(project, env.listener);
    env.watchers[0]?.onChange(['a.ts', 'b.ts'], false);
    await flush();
    expect(env.syncCalls).toHaveLength(0);
    expect(env.statuses.at(-1)).toMatchObject({ state: 'stale', staleReason: 'dirty' });
    expect(await env.uc.status(project)).toMatchObject({ state: 'stale', staleReason: 'dirty' });
    h.stop();
  });

  it('turns stale config on fullIndexRequired and does not retry', async () => {
    const env = setup({
      sync: async (o) => {
        env.syncCalls.push(o);
        return { ...OK, fullIndexRequired: true };
      },
    });
    await indexed(env);
    const h = env.uc.watch(project, env.listener);
    env.watchers[0]?.onChange(['tsconfig.json'], false);
    await flush();
    expect(env.statuses.at(-1)).toMatchObject({ state: 'stale', staleReason: 'config' });
    env.watchers[0]?.onChange(['a.ts'], false);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env.syncCalls).toHaveLength(1);
    h.stop();
  });

  it('emits error once for a failing sync and waits for the next batch', async () => {
    let fail = true;
    const env = setup({
      sync: async (o) => {
        env.syncCalls.push(o);
        if (fail) throw new Error('disk');
        return OK;
      },
    });
    await indexed(env);
    const h = env.uc.watch(project, env.listener);
    env.watchers[0]?.onChange(['a.ts'], false);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env.syncCalls).toHaveLength(1);
    expect(env.statuses.filter((s) => s.state === 'error')).toHaveLength(1);
    fail = false;
    env.watchers[0]?.onChange(['a.ts'], false);
    await flush();
    expect(env.syncCalls).toHaveLength(2);
    expect(env.statuses.at(-1)?.state).toBe('ready');
    h.stop();
  });

  it('flags stale commit when HEAD moves and full-syncs with autoUpdate', async () => {
    const env = setup();
    env.state.head = 'a'.repeat(40);
    await indexed(env);
    const h = env.uc.watch(project, env.listener);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(env.syncCalls).toHaveLength(0);
    env.state.head = 'b'.repeat(40);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(env.statuses.some((s) => s.state === 'stale' && s.staleReason === 'commit')).toBe(true);
    expect(env.syncCalls).toHaveLength(1);
    expect(env.syncCalls[0]?.onlyPaths).toBeUndefined();
    expect((await env.uc.status(project)).state).toBe('ready');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env.syncCalls).toHaveLength(1);
    h.stop();
  });

  it('only flags stale commit when autoUpdate is off', async () => {
    const env = setup();
    env.state.head = 'a'.repeat(40);
    await indexed(env);
    env.uc.setAutoUpdate(project, false);
    const h = env.uc.watch(project, env.listener);
    env.state.head = 'b'.repeat(40);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(env.syncCalls).toHaveLength(0);
    expect(env.statuses.at(-1)).toMatchObject({ state: 'stale', staleReason: 'commit' });
    h.stop();
  });

  it('ref-counts watchers per project and clears the poll timer with the last stop', async () => {
    const env = setup();
    await indexed(env);
    const h1 = env.uc.watch(project, env.listener);
    const h2 = env.uc.watch(project, env.listener);
    expect(env.watchers).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    h1.stop();
    h1.stop();
    expect(env.watchers[0]?.closed).toBe(0);
    h2.stop();
    expect(env.watchers[0]?.closed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses a sixth watched project with CODE_GRAPH_WATCH_LIMIT', () => {
    const env = setup();
    const handles = [1, 2, 3, 4, 5].map((i) => env.uc.watch(path.join(path.sep, 'p', String(i)), env.listener));
    expect(() => env.uc.watch(path.join(path.sep, 'p', '6'), env.listener)).toThrowError(
      expect.objectContaining({ code: 'CODE_GRAPH_WATCH_LIMIT' }),
    );
    expect(() => env.uc.watch(path.join(path.sep, 'p', '1'), env.listener)).not.toThrow();
    handles[0]?.stop();
    handles.forEach((h) => h.stop());
  });

  it('closes the watcher on reset and runs no sync afterwards', async () => {
    const env = setup();
    await indexed(env);
    env.uc.watch(project, env.listener);
    await env.uc.reset(project);
    expect(env.watchers[0]?.closed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    env.watchers[0]?.onChange(['a.ts'], false);
    await flush();
    expect(env.syncCalls).toHaveLength(0);
  });

  it('drops changes during a full index then runs one reconciling unscoped sync', async () => {
    const g = gate();
    const env = setup({
      runIndex: (o): IndexRun => ({
        promise: g.promise.then(() => {
          writeGraph(o.dataDir);
          return { nodes: 0, edges: 0, files: 1, skipped: 0, skippedFiles: [], durationMs: 1, languages: {} };
        }),
        cancel: () => undefined,
      }),
    });
    const h = env.uc.watch(project, env.listener);
    const run = env.uc.index(project, () => undefined);
    env.watchers[0]?.onChange(['a.ts'], false);
    env.watchers[0]?.onChange(['b.ts'], false);
    await flush();
    expect(env.syncCalls).toHaveLength(0);
    g.open();
    await run;
    await flush();
    await flush();
    expect(env.syncCalls).toHaveLength(1);
    expect(env.syncCalls[0]?.onlyPaths).toBeUndefined();
    h.stop();
  });

  it('does not sync when the graph does not exist yet', async () => {
    const env = setup();
    const h = env.uc.watch(project, env.listener);
    env.watchers[0]?.onChange(['a.ts'], false);
    await flush();
    expect(env.syncCalls).toHaveLength(0);
    h.stop();
  });
});

describe('CodeGraphUseCase.watch fix round 1', () => {
  it('syncs a batch that arrived while an external sync held the project, after it ends', async () => {
    const g = gate();
    let first = true;
    const env = setup({
      sync: async (o) => {
        env.syncCalls.push(o);
        env.state.running++;
        env.state.maxRunning = Math.max(env.state.maxRunning, env.state.running);
        if (first) {
          first = false;
          await g.promise;
        }
        env.state.running--;
        return OK;
      },
    });
    await indexed(env);
    const h = env.uc.watch(project, env.listener);
    const external = env.uc.syncNow(project);
    await flush();
    env.watchers[0]?.onChange(['src/a.ts'], false);
    await flush();
    expect(env.syncCalls).toHaveLength(1);
    g.open();
    await external;
    await flush();
    await flush();
    expect(env.syncCalls).toHaveLength(2);
    expect(env.syncCalls[1]?.onlyPaths).toEqual(['src/a.ts']);
    expect(env.state.maxRunning).toBe(1);
    h.stop();
  });

  it('retries after a short unref timer when sync reports skippedBusy, and closeWatch clears it', async () => {
    let busy = true;
    const env = setup({
      sync: async (o) => {
        env.syncCalls.push(o);
        return busy ? { ...OK, skippedBusy: true } : OK;
      },
    });
    await indexed(env);
    const h = env.uc.watch(project, env.listener);
    env.watchers[0]?.onChange(['a.ts'], false);
    await flush();
    expect(env.syncCalls).toHaveLength(1);
    busy = false;
    await vi.advanceTimersByTimeAsync(600);
    expect(env.syncCalls).toHaveLength(2);
    expect(env.syncCalls[1]?.onlyPaths).toEqual(['a.ts']);
    h.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('full-syncs when autoUpdate is enabled while the graph is stale by commit', async () => {
    const env = setup();
    env.state.head = 'a'.repeat(40);
    await indexed(env);
    env.uc.setAutoUpdate(project, false);
    const h = env.uc.watch(project, env.listener);
    env.state.head = 'b'.repeat(40);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(env.syncCalls).toHaveLength(0);
    env.uc.setAutoUpdate(project, true);
    await flush();
    await flush();
    expect(env.syncCalls).toHaveLength(1);
    expect(env.syncCalls[0]?.onlyPaths).toBeUndefined();
    h.stop();
  });

  it('counts distinct dirty paths per window', async () => {
    const env = setup();
    await indexed(env);
    env.uc.setAutoUpdate(project, false);
    const h = env.uc.watch(project, env.listener);
    env.watchers[0]?.onChange(['a.ts'], false);
    env.watchers[0]?.onChange(['a.ts', 'b.ts'], false);
    await flush();
    const internal = env.uc as unknown as { watches: Map<string, { dirtyPaths: Set<string> }> };
    expect(internal.watches.get(project)?.dirtyPaths.size).toBe(2);
    h.stop();
  });

  it('exposes watcher health as watchDegraded and clears it on a fresh watch', async () => {
    const env = setup();
    await indexed(env);
    const h = env.uc.watch(project, env.listener);
    expect((await env.uc.status(project)).watchDegraded).toBeUndefined();
    env.watchers[0]?.opts?.onDegraded?.();
    await flush();
    expect(env.statuses.at(-1)?.watchDegraded).toBe(true);
    expect((await env.uc.status(project)).watchDegraded).toBe(true);
    h.stop();
    expect((await env.uc.status(project)).watchDegraded).toBeUndefined();
    const h2 = env.uc.watch(project, env.listener);
    expect((await env.uc.status(project)).watchDegraded).toBeUndefined();
    env.watchers[1]?.opts?.onError?.(new Error('boom'));
    await flush();
    expect((await env.uc.status(project)).watchDegraded).toBe(true);
    h2.stop();
  });
});
