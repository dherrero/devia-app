import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildAutoUpdateFeature, type UpdaterLike } from './index';
import type { UpdateStatus } from '../../../shared/domain/update';
import type { FeatureContext } from '../../shared/feature';

function makeUpdater() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const updater: UpdaterLike = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn().mockResolvedValue(null),
    quitAndInstall: vi.fn(),
    on(event, listener) {
      listeners.set(event, listener);
      return updater;
    },
  };
  return { updater, listeners };
}

function makeCtx() {
  const sent: UpdateStatus[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ctx = {
    ipc: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
    send: (ch: string, payload: unknown) => {
      if (ch === 'update:status') sent.push(payload as UpdateStatus);
    },
    getMainWindow: () => null,
  } as unknown as FeatureContext;
  return { ctx, sent, handlers };
}

describe('auto-update feature', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('maps updater events to renderer status payloads', () => {
    const { updater, listeners } = makeUpdater();
    const { ctx, sent } = makeCtx();
    buildAutoUpdateFeature({ updater, isPackaged: true }).register(ctx);

    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);

    listeners.get('checking-for-update')!();
    listeners.get('update-available')!({ version: '1.2.3' });
    listeners.get('download-progress')!({ percent: 42.6 });
    listeners.get('update-downloaded')!({ version: '1.2.3' });
    listeners.get('update-not-available')!();

    expect(sent).toEqual([
      { state: 'checking' },
      { state: 'available', version: '1.2.3' },
      { state: 'downloading', percent: 43 },
      { state: 'downloaded', version: '1.2.3' },
      { state: 'not-available' },
    ]);
  });

  it('sanitises error messages (no host paths leak)', () => {
    const { updater, listeners } = makeUpdater();
    const { ctx, sent } = makeCtx();
    buildAutoUpdateFeature({ updater, isPackaged: true }).register(ctx);

    listeners.get('error')!(new Error('ENOENT: /Users/dani/secret/app-update.yml missing'));
    const last = sent.at(-1)!;
    expect(last.state).toBe('error');
    expect(last.error).not.toContain('/Users/dani');
    expect(last.error).toContain('<path>');
  });

  it('schedules a check shortly after ready when packaged', () => {
    const { updater } = makeUpdater();
    const { ctx } = makeCtx();
    const feature = buildAutoUpdateFeature({ updater, isPackaged: true });
    feature.register(ctx);
    feature.onReady!(ctx);

    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('never checks for updates in dev (not packaged)', () => {
    const { updater } = makeUpdater();
    const { ctx } = makeCtx();
    const feature = buildAutoUpdateFeature({ updater, isPackaged: false });
    feature.register(ctx);
    feature.onReady!(ctx);
    vi.advanceTimersByTime(6 * 60 * 60 * 1000);

    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('install IPC quits and installs only when packaged', async () => {
    const { updater } = makeUpdater();
    const { ctx, handlers } = makeCtx();
    buildAutoUpdateFeature({ updater, isPackaged: true }).register(ctx);

    await handlers.get('update:install')!();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('clears timers on quit', () => {
    const { updater } = makeUpdater();
    const { ctx } = makeCtx();
    const feature = buildAutoUpdateFeature({ updater, isPackaged: true });
    feature.register(ctx);
    feature.onReady!(ctx);
    feature.onBeforeQuit!();

    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });
});
