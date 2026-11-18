import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { IPC } from '../../../../shared/contracts/ipc-channels';
import {
  GRAPH_PAGE_LIMIT,
  type CodeGraphStatus,
  type GraphOverviewNode,
  type GraphViewPage,
  type IndexProgress,
} from '../../../../shared/domain/code-graph';
import type { FeatureContext } from '../../../shared/feature';
import type { CodeGraphUseCase, SyncNowResult } from '../application/code-graph.use-case';
import { GraphViewUseCase } from '../application/graph-view.use-case';
import { CodeGraphStore } from '../infrastructure/code-graph-store';
import { registerCodeGraphIpc } from './code-graph.ipc';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const ROOT = path.resolve('/ws');
const abs = (rel: string): string => path.resolve(ROOT, rel);

const status = (over: Partial<CodeGraphStatus> = {}): CodeGraphStatus => ({
  state: 'ready',
  nodeCount: 1,
  edgeCount: 1,
  fileCount: 1,
  languages: {},
  agentAccess: true,
  autoUpdate: true,
  ...over,
});

const progress: IndexProgress = { phase: 'parse', filesDone: 1, filesTotal: 2, nodes: 3, edges: 4 };

class FakeSender extends EventEmitter {
  destroyed = false;
  readonly send = vi.fn();
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

interface Harness {
  handlers: Map<string, Handler>;
  useCase: {
    status: ReturnType<typeof vi.fn>;
    index: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    setAgentAccess: ReturnType<typeof vi.fn>;
    setAutoUpdate: ReturnType<typeof vi.fn>;
    syncNow: ReturnType<typeof vi.fn>;
    watch: ReturnType<typeof vi.fn>;
  };
  view: {
    overview: ReturnType<typeof vi.fn>;
    expand: ReturnType<typeof vi.fn>;
    nodeDetail: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
  };
  listeners: Map<string, (s: CodeGraphStatus) => void>;
  stops: Map<string, ReturnType<typeof vi.fn>>;
  call(channel: string, sender: FakeSender, ...args: unknown[]): unknown;
}

const EMPTY_PAGE: GraphViewPage = { nodes: [], edges: [], total: 0, hasMore: false };

function setup(workspaceRoot = ROOT, realView?: GraphViewUseCase): Harness {
  const handlers = new Map<string, Handler>();
  const ctx = {
    ipc: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
    send: () => undefined,
    getMainWindow: () => null,
  } as unknown as FeatureContext;
  const listeners = new Map<string, (s: CodeGraphStatus) => void>();
  const stops = new Map<string, ReturnType<typeof vi.fn>>();
  const useCase = {
    status: vi.fn(async () => status()),
    index: vi.fn(async () => status()),
    cancel: vi.fn(),
    reset: vi.fn(async () => undefined),
    setAgentAccess: vi.fn(),
    setAutoUpdate: vi.fn(),
    syncNow: vi.fn(async (): Promise<SyncNowResult> => ({ added: 0, modified: 0, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: false })),
    watch: vi.fn((projectAbs: string, listener: (s: CodeGraphStatus) => void) => {
      listeners.set(projectAbs, listener);
      const stop = vi.fn();
      stops.set(projectAbs, stop);
      return { stop };
    }),
  };
  const view = {
    overview: vi.fn(() => EMPTY_PAGE),
    expand: vi.fn(() => EMPTY_PAGE),
    nodeDetail: vi.fn(() => undefined),
    search: vi.fn(() => []),
  };
  registerCodeGraphIpc(ctx, {
    config: { get: () => ({ workspaceRoot }) } as never,
    useCase: useCase as unknown as CodeGraphUseCase,
    view: realView ?? (view as unknown as GraphViewUseCase),
  });
  return { handlers, useCase, view, listeners, stops, call: (channel, sender, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({ sender }, ...args);
    },
  };
}

describe('code-graph IPC', () => {
  let h: Harness;
  let sender: FakeSender;
  beforeEach(() => {
    h = setup();
    sender = new FakeSender();
  });

  it('registers every channel', () => {
    for (const key of [
      'codeGraphStatus', 'codeGraphIndex', 'codeGraphCancel', 'codeGraphReset', 'codeGraphSetAgentAccess',
      'codeGraphSetAutoUpdate', 'codeGraphUpdate', 'codeGraphWatch', 'codeGraphUnwatch',
      'codeGraphOverview', 'codeGraphExpand', 'codeGraphNodeDetail', 'codeGraphSearch', 'codeGraphUsage',
    ] as const) {
      expect(h.handlers.has(IPC[key]), key).toBe(true);
    }
  });

  describe('argument validation and path resolution', () => {
    it.each([undefined, null, '', 42, {}])('rejects a non-string or empty project (%s)', async (bad) => {
      await expect(h.call(IPC.codeGraphStatus, sender, bad)).rejects.toThrow(/project/i);
      await expect(h.call(IPC.codeGraphIndex, sender, bad)).rejects.toThrow(/project/i);
      await expect(h.call(IPC.codeGraphReset, sender, bad)).rejects.toThrow(/project/i);
      await expect(h.call(IPC.codeGraphUpdate, sender, bad)).rejects.toThrow(/project/i);
      expect(() => h.call(IPC.codeGraphCancel, sender, bad)).toThrow(/project/i);
      expect(() => h.call(IPC.codeGraphWatch, sender, bad)).toThrow(/project/i);
      expect(() => h.call(IPC.codeGraphUnwatch, sender, bad)).toThrow(/project/i);
      expect(h.useCase.status).not.toHaveBeenCalled();
    });

    it('rejects a non-boolean enabled flag', () => {
      expect(() => h.call(IPC.codeGraphSetAgentAccess, sender, 'a', 'yes')).toThrow(/enabled/i);
      expect(() => h.call(IPC.codeGraphSetAutoUpdate, sender, 'a', undefined)).toThrow(/enabled/i);
      expect(h.useCase.setAgentAccess).not.toHaveBeenCalled();
    });

    it('rejects ../ escapes and absolute paths before touching the use case', async () => {
      await expect(h.call(IPC.codeGraphStatus, sender, '../evil')).rejects.toThrow(/workspace/i);
      await expect(h.call(IPC.codeGraphIndex, sender, 'a/../../evil')).rejects.toThrow(/workspace/i);
      await expect(h.call(IPC.codeGraphStatus, sender, path.resolve('/etc'))).rejects.toThrow(/workspace/i);
      expect(() => h.call(IPC.codeGraphSetAutoUpdate, sender, '../evil', true)).toThrow(/workspace/i);
      expect(() => h.call(IPC.codeGraphWatch, sender, '../evil')).toThrow(/workspace/i);
      expect(h.useCase.status).not.toHaveBeenCalled();
      expect(h.useCase.index).not.toHaveBeenCalled();
      expect(h.useCase.setAutoUpdate).not.toHaveBeenCalled();
      expect(h.useCase.watch).not.toHaveBeenCalled();
    });

    it('rejects when no workspace is configured', async () => {
      const none = setup('');
      await expect(none.call(IPC.codeGraphStatus, sender, 'a')).rejects.toThrow(/workspace/i);
    });
  });

  describe('status', () => {
    it('resolves the project key and returns the status', async () => {
      h.useCase.status.mockResolvedValue(status({ state: 'none' }));
      const out = await h.call(IPC.codeGraphStatus, sender, 'team/app');
      expect(h.useCase.status).toHaveBeenCalledWith(abs('team/app'));
      expect(out).toMatchObject({ state: 'none' });
    });

    it('sanitizes unexpected errors (no host paths)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      h.useCase.status.mockRejectedValue(new Error(`boom at ${abs('team/app')}/graph.db`));
      const err = await (h.call(IPC.codeGraphStatus, sender, 'team/app') as Promise<unknown>).catch((e: Error) => e);
      expect((err as Error).message).not.toContain(ROOT);
      warn.mockRestore();
    });
  });

  describe('index', () => {
    it('forwards progress to the sender only and resolves with the final status', async () => {
      const other = new FakeSender();
      h.useCase.index.mockImplementation(async (_p: string, onProgress: (p: IndexProgress) => void) => {
        onProgress(progress);
        return status({ nodeCount: 9 });
      });
      const out = await h.call(IPC.codeGraphIndex, sender, 'team/app');
      expect(h.useCase.index).toHaveBeenCalledWith(abs('team/app'), expect.any(Function));
      expect(sender.send).toHaveBeenCalledWith(IPC.codeGraphProgress, { project: 'team/app', progress });
      expect(other.send).not.toHaveBeenCalled();
      expect(out).toMatchObject({ nodeCount: 9 });
    });

    it('does not send progress to a destroyed sender', async () => {
      h.useCase.index.mockImplementation(async (_p: string, onProgress: (p: IndexProgress) => void) => {
        sender.destroyed = true;
        onProgress(progress);
        return status();
      });
      await h.call(IPC.codeGraphIndex, sender, 'a');
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('INDEX_BUSY resolves with the current status', async () => {
      h.useCase.index.mockRejectedValue(coded('INDEX_BUSY'));
      h.useCase.status.mockResolvedValue(status({ state: 'indexing' }));
      await expect(h.call(IPC.codeGraphIndex, sender, 'a')).resolves.toMatchObject({ state: 'indexing' });
    });

    it('AbortError resolves with the current status', async () => {
      h.useCase.index.mockRejectedValue(new DOMException('Index cancelled', 'AbortError'));
      h.useCase.status.mockResolvedValue(status({ state: 'none' }));
      await expect(h.call(IPC.codeGraphIndex, sender, 'a')).resolves.toMatchObject({ state: 'none' });
    });

    it('other errors reject with a sanitized message', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      h.useCase.index.mockRejectedValue(new Error(`EACCES ${ROOT}/secret`));
      const err = await (h.call(IPC.codeGraphIndex, sender, 'a') as Promise<unknown>).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(ROOT);
      warn.mockRestore();
    });
  });

  describe('update', () => {
    it('runs an incremental sync and returns the status without a full index', async () => {
      h.useCase.status.mockResolvedValue(status());
      await expect(h.call(IPC.codeGraphUpdate, sender, 'a')).resolves.toMatchObject({ state: 'ready' });
      expect(h.useCase.syncNow).toHaveBeenCalledWith(abs('a'));
      expect(h.useCase.index).not.toHaveBeenCalled();
    });

    it.each([[{ fullIndexRequired: true }], [{ missing: true }]])('falls back to a full index on %o', async (result) => {
      h.useCase.syncNow.mockResolvedValue(result);
      h.useCase.index.mockImplementation(async (_p: string, onProgress: (p: IndexProgress) => void) => {
        onProgress(progress);
        return status({ nodeCount: 7 });
      });
      await expect(h.call(IPC.codeGraphUpdate, sender, 'a')).resolves.toMatchObject({ nodeCount: 7 });
      expect(h.useCase.index).toHaveBeenCalledWith(abs('a'), expect.any(Function));
      expect(sender.send).toHaveBeenCalledWith(IPC.codeGraphProgress, { project: 'a', progress });
    });

    it('resolves with the current status when the fallback index is busy or aborted', async () => {
      h.useCase.syncNow.mockResolvedValue({ missing: true });
      h.useCase.status.mockResolvedValue(status({ state: 'indexing' }));
      h.useCase.index.mockRejectedValueOnce(coded('INDEX_BUSY'));
      await expect(h.call(IPC.codeGraphUpdate, sender, 'a')).resolves.toMatchObject({ state: 'indexing' });
      h.useCase.index.mockRejectedValueOnce(new DOMException('x', 'AbortError'));
      await expect(h.call(IPC.codeGraphUpdate, sender, 'a')).resolves.toMatchObject({ state: 'indexing' });
    });
  });

  describe('cancel / reset / setters', () => {
    it('cancel and reset delegate with the resolved path', async () => {
      h.call(IPC.codeGraphCancel, sender, 'a');
      await h.call(IPC.codeGraphReset, sender, 'a');
      expect(h.useCase.cancel).toHaveBeenCalledWith(abs('a'));
      expect(h.useCase.reset).toHaveBeenCalledWith(abs('a'));
    });

    it('setters delegate with the flag', () => {
      h.call(IPC.codeGraphSetAgentAccess, sender, 'a', false);
      h.call(IPC.codeGraphSetAutoUpdate, sender, 'a', true);
      expect(h.useCase.setAgentAccess).toHaveBeenCalledWith(abs('a'), false);
      expect(h.useCase.setAutoUpdate).toHaveBeenCalledWith(abs('a'), true);
    });

    it('setters throw CODE_GRAPH_NOT_CREATED synchronously', () => {
      h.useCase.setAgentAccess.mockImplementation(() => {
        throw coded('CODE_GRAPH_NOT_CREATED');
      });
      h.useCase.setAutoUpdate.mockImplementation(() => {
        throw coded('CODE_GRAPH_NOT_CREATED');
      });
      expect(() => h.call(IPC.codeGraphSetAgentAccess, sender, 'a', true)).toThrow('CODE_GRAPH_NOT_CREATED');
      expect(() => h.call(IPC.codeGraphSetAutoUpdate, sender, 'a', true)).toThrow('CODE_GRAPH_NOT_CREATED');
    });
  });

  describe('watch', () => {
    it('is started once per sender and project, and unwatch stops it idempotently', () => {
      h.call(IPC.codeGraphWatch, sender, 'a');
      h.call(IPC.codeGraphWatch, sender, 'a');
      expect(h.useCase.watch).toHaveBeenCalledTimes(1);
      h.call(IPC.codeGraphUnwatch, sender, 'a');
      h.call(IPC.codeGraphUnwatch, sender, 'a');
      h.call(IPC.codeGraphUnwatch, sender, 'never-watched');
      expect(h.stops.get(abs('a'))).toHaveBeenCalledTimes(1);
    });

    it('rejects with CODE_GRAPH_WATCH_LIMIT', () => {
      h.useCase.watch.mockImplementation(() => {
        throw coded('CODE_GRAPH_WATCH_LIMIT');
      });
      expect(() => h.call(IPC.codeGraphWatch, sender, 'a')).toThrow('CODE_GRAPH_WATCH_LIMIT');
    });

    it('routes status-changed only to the sender that watches the project', () => {
      const other = new FakeSender();
      h.call(IPC.codeGraphWatch, sender, 'a');
      h.call(IPC.codeGraphWatch, other, 'b');
      h.listeners.get(abs('a'))?.(status({ state: 'stale' }));
      expect(sender.send).toHaveBeenCalledWith(IPC.codeGraphStatusChanged, { project: 'a', status: status({ state: 'stale' }) });
      expect(other.send).not.toHaveBeenCalled();
    });

    it('stops all of a sender\'s watches when it is destroyed', () => {
      const other = new FakeSender();
      h.call(IPC.codeGraphWatch, sender, 'a');
      h.call(IPC.codeGraphWatch, sender, 'b');
      h.call(IPC.codeGraphWatch, other, 'c');
      sender.destroy();
      expect(h.stops.get(abs('a'))).toHaveBeenCalledTimes(1);
      expect(h.stops.get(abs('b'))).toHaveBeenCalledTimes(1);
      expect(h.stops.get(abs('c'))).not.toHaveBeenCalled();
    });

    it('stops the watches on a main-frame navigation but not on in-page or subframe ones', () => {
      h.call(IPC.codeGraphWatch, sender, 'a');
      sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
      sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
      expect(h.stops.get(abs('a'))).not.toHaveBeenCalled();
      sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      expect(h.stops.get(abs('a'))).toHaveBeenCalledTimes(1);
    });

    it('never sends to a destroyed sender', () => {
      h.call(IPC.codeGraphWatch, sender, 'a');
      sender.destroyed = true;
      h.listeners.get(abs('a'))?.(status());
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('does not leak listeners on the sender after unwatching everything', () => {
      h.call(IPC.codeGraphWatch, sender, 'a');
      h.call(IPC.codeGraphUnwatch, sender, 'a');
      expect(sender.listenerCount('destroyed')).toBe(0);
      expect(sender.listenerCount('did-start-navigation')).toBe(0);
    });
  });

  describe('graph view queries', () => {
    const node = (i: number): GraphOverviewNode => ({ id: `n${i}`, kind: 'function', label: `n${i}`, childCount: 0, path: 'a.ts' });

    it('delegates with the resolved project and the validated arguments', () => {
      h.call(IPC.codeGraphOverview, sender, 'team/app');
      h.call(IPC.codeGraphOverview, sender, 'team/app', { offset: 500 });
      h.call(IPC.codeGraphExpand, sender, 'team/app', 'dir:src', { offset: 500, visibleIds: ['dir:src', 'x'] });
      h.call(IPC.codeGraphExpand, sender, 'team/app', 'dir:lib');
      h.call(IPC.codeGraphNodeDetail, sender, 'team/app', 'file:abc');
      h.call(IPC.codeGraphSearch, sender, 'team/app', 'helper');
      expect(h.view.overview).toHaveBeenNthCalledWith(1, abs('team/app'), {});
      expect(h.view.overview).toHaveBeenNthCalledWith(2, abs('team/app'), { offset: 500 });
      expect(h.view.expand).toHaveBeenNthCalledWith(1, abs('team/app'), 'dir:src', { offset: 500, visibleIds: ['dir:src', 'x'] });
      expect(h.view.expand).toHaveBeenNthCalledWith(2, abs('team/app'), 'dir:lib', { visibleIds: [] });
      expect(h.view.nodeDetail).toHaveBeenCalledWith(abs('team/app'), 'file:abc');
      expect(h.view.search).toHaveBeenCalledWith(abs('team/app'), 'helper');
    });

    it('rejects a bad or escaping project on every view channel', () => {
      for (const bad of [undefined, '', 42]) {
        expect(() => h.call(IPC.codeGraphOverview, sender, bad)).toThrow(/project/i);
        expect(() => h.call(IPC.codeGraphExpand, sender, bad, 'x')).toThrow(/project/i);
        expect(() => h.call(IPC.codeGraphNodeDetail, sender, bad, 'x')).toThrow(/project/i);
        expect(() => h.call(IPC.codeGraphSearch, sender, bad, 'x')).toThrow(/project/i);
      }
      expect(() => h.call(IPC.codeGraphOverview, sender, '../evil')).toThrow(/workspace/i);
      expect(() => h.call(IPC.codeGraphExpand, sender, 'a/../../evil', 'x')).toThrow(/workspace/i);
      expect(() => h.call(IPC.codeGraphNodeDetail, sender, path.resolve('/etc'), 'x')).toThrow(/workspace/i);
      expect(() => h.call(IPC.codeGraphSearch, sender, '../evil', 'x')).toThrow(/workspace/i);
      expect(h.view.overview).not.toHaveBeenCalled();
      expect(h.view.expand).not.toHaveBeenCalled();
      expect(h.view.nodeDetail).not.toHaveBeenCalled();
      expect(h.view.search).not.toHaveBeenCalled();
    });

    it('validates nodeId: non-empty string of at most 1000 chars', () => {
      for (const bad of [undefined, '', 7, 'x'.repeat(1001)]) {
        expect(() => h.call(IPC.codeGraphExpand, sender, 'a', bad)).toThrow(/nodeId/);
        expect(() => h.call(IPC.codeGraphNodeDetail, sender, 'a', bad)).toThrow(/nodeId/);
      }
      h.call(IPC.codeGraphNodeDetail, sender, 'a', 'x'.repeat(1000));
      expect(h.view.nodeDetail).toHaveBeenCalledTimes(1);
      expect(h.view.expand).not.toHaveBeenCalled();
    });

    it('validates the search query: a string of at most 200 chars', () => {
      for (const bad of [undefined, 3, {}, 'q'.repeat(201)]) {
        expect(() => h.call(IPC.codeGraphSearch, sender, 'a', bad)).toThrow(/query/);
      }
      h.call(IPC.codeGraphSearch, sender, 'a', 'q'.repeat(200));
      h.call(IPC.codeGraphSearch, sender, 'a', '');
      expect(h.view.search).toHaveBeenCalledTimes(2);
    });

    it('validates expand options: offset and visibleIds limits', () => {
      const bad: unknown[] = [
        'nope',
        [],
        { offset: -1, visibleIds: [] },
        { offset: 1.5, visibleIds: [] },
        { offset: '3', visibleIds: [] },
        { visibleIds: 'dir:a' },
        { visibleIds: [''] },
        { visibleIds: [7] },
        { visibleIds: ['x'.repeat(1001)] },
        { visibleIds: Array.from({ length: 2001 }, (_, i) => `n${i}`) },
      ];
      for (const opts of bad) {
        expect(() => h.call(IPC.codeGraphExpand, sender, 'a', 'dir:a', opts), JSON.stringify(opts).slice(0, 40)).toThrow(/offset|visibleIds|opts/);
      }
      expect(h.view.expand).not.toHaveBeenCalled();
      h.call(IPC.codeGraphExpand, sender, 'a', 'dir:a', { offset: 0, visibleIds: Array.from({ length: 2000 }, (_, i) => `n${i}`) });
      expect(h.view.expand).toHaveBeenCalledTimes(1);
    });

    it('validates overview options: an object with a non-negative integer offset', () => {
      for (const opts of ['nope', [], null, { offset: -1 }, { offset: 1.5 }, { offset: '3' }]) {
        expect(() => h.call(IPC.codeGraphOverview, sender, 'a', opts), JSON.stringify(opts)).toThrow(/offset|opts/);
      }
      expect(h.view.overview).not.toHaveBeenCalled();
      h.call(IPC.codeGraphOverview, sender, 'a', { offset: 0 });
      h.call(IPC.codeGraphOverview, sender, 'a', undefined);
      expect(h.view.overview).toHaveBeenCalledTimes(2);
    });

    it('never returns a page above GRAPH_PAGE_LIMIT nodes', () => {
      const nodes = Array.from({ length: GRAPH_PAGE_LIMIT + 500 }, (_, i) => node(i));
      const edges = [
        { source: 'n0', target: 'n1', kind: 'aggregate', weight: 1 },
        { source: 'n0', target: `n${GRAPH_PAGE_LIMIT + 10}`, kind: 'aggregate', weight: 1 },
        { source: 'n0', target: 'dir:visible', kind: 'aggregate', weight: 1 },
      ];
      const big = { nodes, edges, total: nodes.length, hasMore: false };
      h.view.overview.mockReturnValue(big);
      h.view.expand.mockReturnValue(big);
      for (const page of [
        h.call(IPC.codeGraphOverview, sender, 'a') as GraphViewPage,
        h.call(IPC.codeGraphExpand, sender, 'a', 'dir:a', { visibleIds: ['dir:visible'] }) as GraphViewPage,
      ]) {
        expect(page.nodes).toHaveLength(GRAPH_PAGE_LIMIT);
        expect(page.hasMore).toBe(true);
        expect(page.edges.map((e) => e.target)).toEqual(['n1', 'dir:visible']);
      }
    });

    it('sanitizes unexpected view errors (no host paths)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      h.view.overview.mockImplementation(() => {
        throw new Error(`SQLITE_CORRUPT ${ROOT}/graph.db`);
      });
      let err: unknown;
      try {
        h.call(IPC.codeGraphOverview, sender, 'a');
      } catch (e) {
        err = e;
      }
      expect((err as Error).message).toBe('Code graph operation failed');
      warn.mockRestore();
    });

    it('answers success-shaped empties when the project has no graph', () => {
      const deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ipc-view-'));
      try {
        const real = setup(ROOT, new GraphViewUseCase({ store: new CodeGraphStore(() => deviaDir) }));
        expect(real.call(IPC.codeGraphOverview, sender, 'a')).toEqual(EMPTY_PAGE);
        expect(real.call(IPC.codeGraphExpand, sender, 'a', 'dir:src', { visibleIds: [] })).toEqual(EMPTY_PAGE);
        expect(real.call(IPC.codeGraphNodeDetail, sender, 'a', 'dir:src')).toBeUndefined();
        expect(real.call(IPC.codeGraphSearch, sender, 'a', 'helper')).toEqual([]);
      } finally {
        fs.rmSync(deviaDir, { recursive: true, force: true });
      }
    });
  });
});
