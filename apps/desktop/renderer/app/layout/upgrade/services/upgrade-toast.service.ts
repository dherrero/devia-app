import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { ElectronApiService } from '../../../core/services/electron-api.service';

/**
 * Payload carried on the `paywall-requested` DOM event. Emitted by the
 * EntitlementChunkLoader on a Pro-route rejection (ticket #254) and by any
 * future feature that detects a `quota_exceeded` outcome — both fire it
 * via `window.dispatchEvent(new CustomEvent('paywall-requested', { detail }))`.
 *
 * `feature` is a short slug ("pinned", "multi-execution", …) used to:
 *  1. Pick the right body string in the toast.
 *  2. Drive the `?feature=` query param in the upgrade deep link.
 */
export interface PaywallRequestedDetail {
  feature: string;
}

declare global {
  interface WindowEventMap {
    'paywall-requested': CustomEvent<PaywallRequestedDetail>;
  }
}

/** Internal toast state. `null` when no toast is visible. */
export interface UpgradeToastState {
  feature: string;
}

/**
 * Coalesces `paywall-requested` events into a single visible toast and
 * routes the CTA click through the bridge so the saas web origin opens in
 * the user's default browser (ticket #258).
 *
 * Behavioural contract:
 *  - Multiple events arriving within the debounce window collapse into one
 *    toast keyed by the FIRST `feature` slug. This matches the user spec
 *    ("debounce 2s so multiple rapid clicks on a locked area show one
 *    toast").
 *  - The toast persists until either {@link dismiss} or {@link activate}
 *    is called; it does NOT auto-hide. Free users see the gate explicitly.
 */
@Injectable({ providedIn: 'root' })
export class UpgradeToastService {
  /** Window in milliseconds during which incoming events are collapsed. */
  static readonly DEBOUNCE_MS = 2_000;

  private readonly api = inject(ElectronApiService);
  private readonly state = signal<UpgradeToastState | null>(null);

  /** Last time a paywall event was honoured; used as the debounce anchor. */
  private lastShownAt = 0;

  /** Read-only state for components — null when no toast is visible. */
  readonly current = computed<UpgradeToastState | null>(() => this.state());

  /** True when a toast is currently on screen. */
  readonly visible = computed(() => this.state() !== null);

  constructor() {
    const destroyRef = inject(DestroyRef);
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<PaywallRequestedDetail>).detail;
      this.show(detail?.feature ?? 'unknown');
    };
    window.addEventListener('paywall-requested', listener);
    destroyRef.onDestroy(() => {
      window.removeEventListener('paywall-requested', listener);
    });
  }

  /**
   * Programmatic show. Honoured immediately on first call; subsequent calls
   * within {@link DEBOUNCE_MS} are dropped so a burst of events from rapid
   * clicks on a locked surface still surfaces a single toast.
   */
  show(feature: string): void {
    const now = Date.now();
    const inWindow = now - this.lastShownAt < UpgradeToastService.DEBOUNCE_MS;
    if (inWindow && this.state() !== null) {
      return;
    }
    this.lastShownAt = now;
    this.state.set({ feature });
  }

  /** Dismiss without launching the upgrade URL. */
  dismiss(): void {
    this.state.set(null);
  }

  /**
   * CTA handler. Opens the saas upgrade page in the user's default browser
   * and dismisses the toast. Returns the promise so callers (tests, future
   * busy-state UI) can await the IPC round-trip.
   */
  async activate(): Promise<void> {
    const feature = this.state()?.feature;
    if (!feature) return;
    try {
      await this.api.openUpgrade(feature);
    } catch (err) {
      console.error('[upgrade-toast] openUpgrade failed:', err);
    }
    this.dismiss();
  }
}
