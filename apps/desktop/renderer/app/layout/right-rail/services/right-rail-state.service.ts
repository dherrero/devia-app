import { Injectable, computed, effect, signal } from '@angular/core';

export type RightRailTab = 'terminal' | 'tree' | 'docker';

const STORAGE_KEY = 'devia:rightRail';
const DEFAULT_WIDTH_PX = 360;
const MIN_WIDTH_PX = 220;

interface PersistedState {
  widthPx: number;
  activeTab: RightRailTab | null;
}

/**
 * Holds the right-rail's UI state (which tab is active, panel width).
 * Persisted in localStorage so the rail re-opens to the same view on
 * reload. The rail always renders — when `activeTab()` is null only the
 * 44px icon column is visible; otherwise the panel expands to the left.
 */
@Injectable({ providedIn: 'root' })
export class RightRailStateService {
  readonly activeTab = signal<RightRailTab | null>(null);
  readonly widthPx = signal<number>(DEFAULT_WIDTH_PX);

  readonly isOpen = computed(() => this.activeTab() !== null);

  /** True while the user is dragging the splitter — drives the splitter's
   *  active visual state and disables CSS transitions on the panel. */
  readonly isResizing = signal(false);

  static readonly MIN_WIDTH_PX = MIN_WIDTH_PX;
  static readonly DEFAULT_WIDTH_PX = DEFAULT_WIDTH_PX;

  constructor() {
    const restored = loadState();
    if (restored) {
      this.widthPx.set(restored.widthPx);
      this.activeTab.set(restored.activeTab);
    }
    // Persist on any change. Effect runs after the initial restore because
    // signal writes during construction are batched into the first tick.
    effect(() => {
      saveState({ widthPx: this.widthPx(), activeTab: this.activeTab() });
    });
  }

  /** Toggle behavior: clicking the active tab's icon closes the panel.
   *  Clicking a different tab's icon switches without closing. */
  toggleTab(tab: RightRailTab): void {
    this.activeTab.set(this.activeTab() === tab ? null : tab);
  }

  /** Programmatic open — used by keyboard shortcuts and cross-component
   *  flows (e.g. "focus this file in tree"). */
  openTab(tab: RightRailTab): void {
    this.activeTab.set(tab);
  }

  closePanel(): void {
    this.activeTab.set(null);
  }

  setWidth(px: number, maxPx: number): void {
    const clamped = Math.max(MIN_WIDTH_PX, Math.min(maxPx, px));
    this.widthPx.set(clamped);
  }
}

function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const widthPx = typeof parsed.widthPx === 'number' && Number.isFinite(parsed.widthPx)
      ? Math.max(MIN_WIDTH_PX, parsed.widthPx)
      : DEFAULT_WIDTH_PX;
    const activeTab: RightRailTab | null =
      parsed.activeTab === 'terminal' || parsed.activeTab === 'tree' || parsed.activeTab === 'docker'
        ? parsed.activeTab
        : null;
    return { widthPx, activeTab };
  } catch {
    return null;
  }
}

function saveState(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore — quota / private mode */
  }
}
