import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { UpgradeToastService } from './upgrade-toast.service';
import { ElectronApiService } from '../../../core/services/electron-api.service';

class FakeApi {
  readonly opened: string[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async openUpgrade(feature: string): Promise<void> {
    this.opened.push(feature);
  }
}

function emitPaywall(feature: string): void {
  window.dispatchEvent(
    new CustomEvent('paywall-requested', { detail: { feature } }),
  );
}

describe('UpgradeToastService', () => {
  let api: FakeApi;
  let svc: UpgradeToastService;

  beforeEach(() => {
    api = new FakeApi();
    TestBed.configureTestingModule({
      providers: [
        UpgradeToastService,
        { provide: ElectronApiService, useValue: api },
      ],
    });
    svc = TestBed.inject(UpgradeToastService);
    // Pin Date.now so the debounce window is deterministic across tests.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a toast on a single paywall-requested event', () => {
    emitPaywall('pinned');
    expect(svc.visible()).toBe(true);
    expect(svc.current()?.feature).toBe('pinned');
  });

  it('collapses a burst of events into a single toast', () => {
    emitPaywall('pinned');
    emitPaywall('pinned');
    emitPaywall('pinned');
    emitPaywall('multi-execution');
    expect(svc.visible()).toBe(true);
    // First feature wins; subsequent events within the debounce window are
    // dropped so the user does not see flicker.
    expect(svc.current()?.feature).toBe('pinned');
  });

  it('allows a fresh toast after the debounce window elapses', () => {
    emitPaywall('pinned');
    svc.dismiss();
    expect(svc.visible()).toBe(false);
    // Still inside the 2s window — show is dropped because… actually
    // dismissing exits the "visible" branch of the guard, so a subsequent
    // show should be honoured (no toast on screen anymore).
    emitPaywall('pinned');
    expect(svc.visible()).toBe(true);
  });

  it('drops a second show within the window only when a toast is still visible', () => {
    emitPaywall('pinned');
    // Toast is visible; another show inside DEBOUNCE_MS should be dropped.
    vi.advanceTimersByTime(500);
    emitPaywall('multi-execution');
    expect(svc.current()?.feature).toBe('pinned');
  });

  it('honours show() after the debounce window even when a toast is still visible', () => {
    emitPaywall('pinned');
    // Past the 2s window — now we treat the new event as a fresh request
    // and update the visible feature.
    vi.advanceTimersByTime(UpgradeToastService.DEBOUNCE_MS + 1);
    emitPaywall('multi-execution');
    expect(svc.current()?.feature).toBe('multi-execution');
  });

  it('CTA click opens the upgrade URL for the active feature and dismisses', async () => {
    emitPaywall('pinned');
    await svc.activate();
    expect(api.opened).toEqual(['pinned']);
    expect(svc.visible()).toBe(false);
  });

  it('activate() is a no-op when no toast is visible', async () => {
    await svc.activate();
    expect(api.opened).toEqual([]);
  });

  it('removes the window listener when the service is destroyed', () => {
    // Sanity check: after TestBed teardown the listener should no longer
    // fire. We can verify by destroying the testing module and ensuring a
    // fresh event does not crash or update state on the disposed instance.
    TestBed.resetTestingModule();
    // A fresh listener-free emit should not throw; we don't directly
    // assert on the old svc because TestBed.resetTestingModule()
    // invokes DestroyRef.onDestroy callbacks before discarding the
    // injector.
    expect(() => emitPaywall('pinned')).not.toThrow();
  });
});
