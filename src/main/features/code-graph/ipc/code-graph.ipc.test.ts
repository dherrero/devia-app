import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { IPC } from '../../../../shared/contracts/ipc-channels';
import type { CodeGraphStatus, IndexProgress } from '../../../../shared/domain/code-graph';
import type { FeatureContext } from '../../../shared/feature';
import type { CodeGraphUseCase, SyncNowResult } from '../application/code-graph.use-case';
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
  listeners: Map<string, (s: CodeGraphStatus) => void>;
  stops: Map<string, ReturnType<typeof vi.fn>>;
  call(channel: string, sender: FakeSender, ...args: unknown[]): unknown;
}

function setup(workspaceRoot = ROOT): Harness {
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
  registerCodeGraphIpc(ctx, {
    config: { get: () => ({ workspaceRoot }) } as never,
    useCase: useCase as unknown as CodeGraphUseCase,
  });
  return { handlers, useCase, listeners, stops, call: (channel, sender, ...args) => {
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
});
