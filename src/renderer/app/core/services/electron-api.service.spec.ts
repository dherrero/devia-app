/**
 * T-73 — `mcp:list-changed` listeners were accumulating on the
 * contextBridge channel because the subscription API returned void.
 * Now `onMcpListChanged` must return the unsubscribe that the bridge
 * itself returns, so transient consumers (modals, per-message cards)
 * can release the listener and the EventEmitter no longer overflows
 * (MaxListenersExceededWarning at 11 listeners).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ElectronApiService } from './electron-api.service';

describe('ElectronApiService.onMcpListChanged', () => {
  const unsubscribe = vi.fn();
  const onListChanged = vi.fn(() => unsubscribe);
  const noop = (): void => undefined;
  const originalDevia = (window as unknown as { devia?: unknown }).devia;

  beforeEach(() => {
    unsubscribe.mockClear();
    onListChanged.mockClear();
    // ElectronApiService binds many on* handlers in field initialisers; if
    // they are missing the constructor throws on `.bind(...)`. So we stub
    // every subscription with a noop and only override the one under test.
    (window as unknown as { devia?: unknown }).devia = {
      platform: 'linux',
      isWSL: false,
      onClaudeOutput: noop,
      onProcessStart: noop,
      onSessionHandoff: noop,
      onSessionReset: noop,
      onAutoResumeScheduled: noop,
      onAutoResumeCancelled: noop,
      onProcessEnd: noop,
      onComposeStart: noop,
      onComposeOutput: noop,
      onComposeEnd: noop,
      onOutboxFile: noop,
      onCloneStart: noop,
      onCloneOutput: noop,
      onCloneEnd: noop,
      onGitInfoChanged: noop,
      onConfigChanged: noop,
      onNotificationClick: noop,
      onAgentChanged: noop,
      onQueueChanged: noop,
      onQueueDispatched: noop,
      onTerminalData: noop,
      onTerminalExit: noop,
      onQuestionAsk: noop,
      onUiToolRequest: noop,
      onDiffSnapshot: noop,
      onCodeGraphProgress: noop,
      onCodeGraphStatusChanged: noop,
      mcp: { onListChanged },
    };
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    (window as unknown as { devia?: unknown }).devia = originalDevia;
  });

  it('delegates the callback to the bridge and returns the unsubscribe', () => {
    const service = TestBed.inject(ElectronApiService);
    const cb = vi.fn();

    const cleanup = service.onMcpListChanged(cb);

    expect(onListChanged).toHaveBeenCalledTimes(1);
    expect(onListChanged).toHaveBeenCalledWith(cb);
    expect(typeof cleanup).toBe('function');

    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('ElectronApiService code graph wrappers', () => {
  const originalDevia = (window as unknown as { devia?: unknown }).devia;
  const unsubscribe = vi.fn();
  const bridge = {
    platform: 'linux',
    isWSL: false,
    codeGraphStatus: vi.fn(async () => ({ state: 'none' })),
    codeGraphIndex: vi.fn(async () => ({ state: 'ready' })),
    codeGraphCancel: vi.fn(async () => undefined),
    codeGraphReset: vi.fn(async () => undefined),
    codeGraphSetAgentAccess: vi.fn(async () => undefined),
    codeGraphSetAutoUpdate: vi.fn(async () => undefined),
    codeGraphUpdate: vi.fn(async () => ({ state: 'ready' })),
    codeGraphWatch: vi.fn(async () => undefined),
    codeGraphUnwatch: vi.fn(async () => undefined),
    onCodeGraphProgress: vi.fn(() => unsubscribe),
    onCodeGraphStatusChanged: vi.fn(() => unsubscribe),
  };

  beforeEach(() => {
    (window as unknown as { devia?: unknown }).devia = new Proxy(bridge, {
      get: (target, prop) => (prop in target ? target[prop as keyof typeof target] : () => undefined),
    });
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    (window as unknown as { devia?: unknown }).devia = originalDevia;
  });

  it('forwards the project key and flags to the bridge', async () => {
    const service = TestBed.inject(ElectronApiService);

    await service.codeGraphStatus('a/b');
    await service.codeGraphIndex('a/b');
    await service.codeGraphCancel('a/b');
    await service.codeGraphReset('a/b');
    await service.codeGraphSetAgentAccess('a/b', false);
    await service.codeGraphSetAutoUpdate('a/b', true);
    await service.codeGraphUpdate('a/b');
    await service.codeGraphWatch('a/b');
    await service.codeGraphUnwatch('a/b');

    expect(bridge.codeGraphStatus).toHaveBeenCalledWith('a/b');
    expect(bridge.codeGraphIndex).toHaveBeenCalledWith('a/b');
    expect(bridge.codeGraphCancel).toHaveBeenCalledWith('a/b');
    expect(bridge.codeGraphReset).toHaveBeenCalledWith('a/b');
    expect(bridge.codeGraphSetAgentAccess).toHaveBeenCalledWith('a/b', false);
    expect(bridge.codeGraphSetAutoUpdate).toHaveBeenCalledWith('a/b', true);
    expect(bridge.codeGraphUpdate).toHaveBeenCalledWith('a/b');
    expect(bridge.codeGraphWatch).toHaveBeenCalledWith('a/b');
    expect(bridge.codeGraphUnwatch).toHaveBeenCalledWith('a/b');
  });

  it('returns the unsubscribe of both event subscriptions', () => {
    const service = TestBed.inject(ElectronApiService);
    const cb = vi.fn();

    const offProgress = service.onCodeGraphProgress(cb);
    const offStatus = service.onCodeGraphStatusChanged(cb);

    expect(bridge.onCodeGraphProgress).toHaveBeenCalledWith(cb);
    expect(bridge.onCodeGraphStatusChanged).toHaveBeenCalledWith(cb);
    offProgress();
    offStatus();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
