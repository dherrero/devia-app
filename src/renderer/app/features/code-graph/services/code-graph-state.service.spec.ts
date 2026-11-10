import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodeGraphProgressPayload, CodeGraphStatusChangedPayload } from '../../../../../shared/contracts/events';
import type { CodeGraphStatus, IndexProgress } from '../../../../../shared/domain/code-graph';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { CodeGraphStateService } from './code-graph-state.service';

function status(over: Partial<CodeGraphStatus> = {}): CodeGraphStatus {
  return {
    state: 'none',
    nodeCount: 0,
    edgeCount: 0,
    fileCount: 0,
    languages: {},
    agentAccess: false,
    autoUpdate: false,
    ...over,
  };
}

const PROGRESS: IndexProgress = { phase: 'parse', filesDone: 3, filesTotal: 10, nodes: 30, edges: 40 };

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Electron wraps IPC rejections: the domain code is only a substring of the message. */
function ipcError(code: string): Error {
  return new Error(`Error invoking remote method 'code-graph:x': Error: ${code}`);
}

function makeApi() {
  const progressListeners = new Set<(e: CodeGraphProgressPayload) => void>();
  const statusListeners = new Set<(e: CodeGraphStatusChangedPayload) => void>();
  const offProgress = vi.fn();
  const offStatus = vi.fn();
  return {
    progressListeners,
    statusListeners,
    offProgress,
    offStatus,
    emitProgress: (e: CodeGraphProgressPayload) => progressListeners.forEach((cb) => cb(e)),
    emitStatus: (e: CodeGraphStatusChangedPayload) => statusListeners.forEach((cb) => cb(e)),
    codeGraphStatus: vi.fn<(p: string) => Promise<CodeGraphStatus>>(() => Promise.resolve(status())),
    codeGraphIndex: vi.fn<(p: string) => Promise<CodeGraphStatus>>(() => Promise.resolve(status({ state: 'ready', nodeCount: 5 }))),
    codeGraphUpdate: vi.fn<(p: string) => Promise<CodeGraphStatus>>(() => Promise.resolve(status({ state: 'ready' }))),
    codeGraphCancel: vi.fn<(p: string) => Promise<void>>(() => Promise.resolve()),
    codeGraphReset: vi.fn<(p: string) => Promise<void>>(() => Promise.resolve()),
    codeGraphSetAgentAccess: vi.fn<(p: string, on: boolean) => Promise<void>>(() => Promise.resolve()),
    codeGraphSetAutoUpdate: vi.fn<(p: string, on: boolean) => Promise<void>>(() => Promise.resolve()),
    codeGraphWatch: vi.fn<(p: string) => Promise<void>>(() => Promise.resolve()),
    codeGraphUnwatch: vi.fn<(p: string) => Promise<void>>(() => Promise.resolve()),
    onCodeGraphProgress: vi.fn((cb: (e: CodeGraphProgressPayload) => void) => {
      progressListeners.add(cb);
      return () => {
        offProgress();
        progressListeners.delete(cb);
      };
    }),
    onCodeGraphStatusChanged: vi.fn((cb: (e: CodeGraphStatusChangedPayload) => void) => {
      statusListeners.add(cb);
      return () => {
        offStatus();
        statusListeners.delete(cb);
      };
    }),
  };
}

describe('CodeGraphStateService (S-44 T-506)', () => {
  let api: ReturnType<typeof makeApi>;
  let svc: CodeGraphStateService;

  beforeEach(() => {
    api = makeApi();
    TestBed.configureTestingModule({
      providers: [{ provide: ElectronApiService, useValue: api }],
    });
    svc = TestBed.inject(CodeGraphStateService);
  });

  it('starts empty', () => {
    expect(svc.status()).toBeNull();
    expect(svc.progress()).toBeNull();
    expect(svc.project()).toBeNull();
    expect(svc.loading()).toBe(false);
    expect(svc.busy()).toBe(false);
    expect(svc.error()).toBeNull();
    expect(svc.watchUnavailable()).toBe(false);
  });

  it('open() loads the status, subscribes once and watches the project', async () => {
    const pending = deferred<CodeGraphStatus>();
    api.codeGraphStatus.mockReturnValueOnce(pending.promise);
    const opening = svc.open('proj-a');
    expect(svc.loading()).toBe(true);
    expect(svc.project()).toBe('proj-a');
    pending.resolve(status({ state: 'ready', nodeCount: 9 }));
    await opening;

    expect(svc.loading()).toBe(false);
    expect(svc.status()?.state).toBe('ready');
    expect(svc.status()?.nodeCount).toBe(9);
    expect(api.codeGraphStatus).toHaveBeenCalledWith('proj-a');
    expect(api.onCodeGraphProgress).toHaveBeenCalledTimes(1);
    expect(api.onCodeGraphStatusChanged).toHaveBeenCalledTimes(1);
    expect(api.codeGraphWatch).toHaveBeenCalledWith('proj-a');
  });

  it('applies progress and status events of the open project', async () => {
    await svc.open('proj-a');
    api.emitProgress({ project: 'proj-a', progress: PROGRESS });
    expect(svc.progress()).toEqual(PROGRESS);
    api.emitStatus({ project: 'proj-a', status: status({ state: 'stale', staleReason: 'commit' }) });
    expect(svc.status()?.state).toBe('stale');
    expect(svc.status()?.staleReason).toBe('commit');
  });

  it('ignores events for other projects', async () => {
    await svc.open('proj-a');
    api.emitProgress({ project: 'proj-b', progress: PROGRESS });
    api.emitStatus({ project: 'proj-b', status: status({ state: 'error' }) });
    expect(svc.progress()).toBeNull();
    expect(svc.status()?.state).toBe('none');
  });

  it('close() unwatches, unsubscribes and clears the state; a second close is a no-op', async () => {
    await svc.open('proj-a');
    await svc.close();

    expect(api.codeGraphUnwatch).toHaveBeenCalledTimes(1);
    expect(api.codeGraphUnwatch).toHaveBeenCalledWith('proj-a');
    expect(api.offProgress).toHaveBeenCalledTimes(1);
    expect(api.offStatus).toHaveBeenCalledTimes(1);
    expect(svc.status()).toBeNull();
    expect(svc.project()).toBeNull();
    expect(svc.progress()).toBeNull();

    await svc.close();
    expect(api.codeGraphUnwatch).toHaveBeenCalledTimes(1);
    expect(api.offProgress).toHaveBeenCalledTimes(1);
  });

  it('close() tolerates an unwatch failure', async () => {
    await svc.open('proj-a');
    api.codeGraphUnwatch.mockRejectedValueOnce(new Error('boom'));
    await expect(svc.close()).resolves.toBeUndefined();
    expect(svc.project()).toBeNull();
  });

  it('switching project closes the previous one first', async () => {
    await svc.open('proj-a');
    await svc.open('proj-b');

    expect(api.codeGraphUnwatch).toHaveBeenCalledWith('proj-a');
    expect(api.codeGraphWatch).toHaveBeenLastCalledWith('proj-b');
    expect(svc.project()).toBe('proj-b');
    expect(api.statusListeners.size).toBe(1);
    expect(api.progressListeners.size).toBe(1);

    api.emitProgress({ project: 'proj-a', progress: PROGRESS });
    expect(svc.progress()).toBeNull();
    api.emitProgress({ project: 'proj-b', progress: PROGRESS });
    expect(svc.progress()).toEqual(PROGRESS);
  });

  it('a late status response for the previous project does not overwrite the new one', async () => {
    const slowA = deferred<CodeGraphStatus>();
    api.codeGraphStatus.mockImplementation((p: string) =>
      p === 'proj-a' ? slowA.promise : Promise.resolve(status({ state: 'ready' })),
    );
    const openingA = svc.open('proj-a');
    await svc.open('proj-b');
    slowA.resolve(status({ state: 'error' }));
    await openingA;

    expect(svc.project()).toBe('proj-b');
    expect(svc.status()?.state).toBe('ready');
    expect(svc.loading()).toBe(false);
    expect(api.codeGraphWatch).not.toHaveBeenCalledWith('proj-a');
  });

  it('a late index response for the previous project does not overwrite the new one', async () => {
    const slowIndex = deferred<CodeGraphStatus>();
    api.codeGraphIndex.mockReturnValueOnce(slowIndex.promise);
    await svc.open('proj-a');
    const indexing = svc.index();
    await svc.open('proj-b');
    expect(svc.busy()).toBe(false);
    slowIndex.resolve(status({ state: 'ready', nodeCount: 77 }));
    await indexing;

    expect(svc.status()?.nodeCount).toBe(0);
    expect(svc.busy()).toBe(false);
  });

  it('index() sets busy while it runs and applies the returned status', async () => {
    await svc.open('proj-a');
    const pending = deferred<CodeGraphStatus>();
    api.codeGraphIndex.mockReturnValueOnce(pending.promise);
    const indexing = svc.index();
    expect(svc.busy()).toBe(true);
    expect(svc.status()?.state).toBe('indexing');
    pending.resolve(status({ state: 'ready', nodeCount: 5 }));
    await indexing;

    expect(api.codeGraphIndex).toHaveBeenCalledWith('proj-a');
    expect(svc.busy()).toBe(false);
    expect(svc.status()?.state).toBe('ready');
    expect(svc.progress()).toBeNull();
  });

  it('index() clears busy and restores the status when it fails', async () => {
    await svc.open('proj-a');
    api.codeGraphIndex.mockRejectedValueOnce(new Error('Code graph operation failed'));
    await svc.index();

    expect(svc.busy()).toBe(false);
    expect(svc.status()?.state).toBe('none');
    expect(svc.error()).toContain('Code graph operation failed');
  });

  it('cancel() during an index: the index resolving with the current status is a normal outcome', async () => {
    await svc.open('proj-a');
    const pending = deferred<CodeGraphStatus>();
    api.codeGraphIndex.mockReturnValueOnce(pending.promise);
    const indexing = svc.index();
    await svc.cancel();
    expect(api.codeGraphCancel).toHaveBeenCalledWith('proj-a');
    pending.resolve(status({ state: 'none' }));
    await indexing;

    expect(svc.busy()).toBe(false);
    expect(svc.error()).toBeNull();
    expect(svc.status()?.state).toBe('none');
  });

  it('update() sets busy and applies the returned status', async () => {
    await svc.open('proj-a');
    api.codeGraphUpdate.mockResolvedValueOnce(status({ state: 'ready', nodeCount: 3 }));
    const updating = svc.update();
    expect(svc.busy()).toBe(true);
    await updating;
    expect(svc.busy()).toBe(false);
    expect(svc.status()?.nodeCount).toBe(3);
  });

  it('reset() refreshes the status afterwards', async () => {
    await svc.open('proj-a');
    api.codeGraphStatus.mockResolvedValueOnce(status({ state: 'none' }));
    await svc.reset();
    expect(api.codeGraphReset).toHaveBeenCalledWith('proj-a');
    expect(api.codeGraphStatus).toHaveBeenCalledTimes(2);
    expect(svc.status()?.state).toBe('none');
  });

  it('setAgentAccess()/setAutoUpdate() call the bridge and refresh the status', async () => {
    await svc.open('proj-a');
    api.codeGraphStatus.mockResolvedValueOnce(status({ state: 'ready', agentAccess: true }));
    await svc.setAgentAccess(true);
    expect(api.codeGraphSetAgentAccess).toHaveBeenCalledWith('proj-a', true);
    expect(svc.status()?.agentAccess).toBe(true);

    api.codeGraphStatus.mockResolvedValueOnce(status({ state: 'ready', agentAccess: true, autoUpdate: true }));
    await svc.setAutoUpdate(true);
    expect(api.codeGraphSetAutoUpdate).toHaveBeenCalledWith('proj-a', true);
    expect(svc.status()?.autoUpdate).toBe(true);
  });

  it('maps a wrapped CODE_GRAPH_NOT_CREATED rejection to its domain code', async () => {
    await svc.open('proj-a');
    api.codeGraphSetAgentAccess.mockRejectedValueOnce(ipcError('CODE_GRAPH_NOT_CREATED'));
    await svc.setAgentAccess(true);
    expect(svc.error()).toBe('CODE_GRAPH_NOT_CREATED');
  });

  it('a wrapped CODE_GRAPH_WATCH_LIMIT marks the watch unavailable without an error', async () => {
    api.codeGraphWatch.mockRejectedValueOnce(ipcError('CODE_GRAPH_WATCH_LIMIT'));
    await svc.open('proj-a');
    expect(svc.watchUnavailable()).toBe(true);
    expect(svc.error()).toBeNull();
    expect(svc.status()?.state).toBe('none');
  });

  it('a failed first status load surfaces the error and stops loading', async () => {
    api.codeGraphStatus.mockRejectedValueOnce(new Error('Code graph operation failed'));
    await svc.open('proj-a');
    expect(svc.loading()).toBe(false);
    expect(svc.status()).toBeNull();
    expect(svc.error()).toContain('Code graph operation failed');
  });

  it('dismissError() clears an action failure and keeps the status', async () => {
    await svc.open('proj-a');
    api.codeGraphSetAutoUpdate.mockRejectedValueOnce(ipcError('CODE_GRAPH_NOT_CREATED'));
    await svc.setAutoUpdate(true);
    expect(svc.error()).toBe('CODE_GRAPH_NOT_CREATED');
    svc.dismissError();
    expect(svc.error()).toBeNull();
    expect(svc.status()?.state).toBe('none');
  });

  it('actions are no-ops without an open project', async () => {
    await svc.index();
    await svc.update();
    await svc.cancel();
    expect(api.codeGraphIndex).not.toHaveBeenCalled();
    expect(api.codeGraphUpdate).not.toHaveBeenCalled();
    expect(api.codeGraphCancel).not.toHaveBeenCalled();
  });
});
