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
