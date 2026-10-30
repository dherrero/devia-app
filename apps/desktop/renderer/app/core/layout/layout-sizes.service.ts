import {
  DestroyRef,
  Injectable,
  Injector,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

/**
 * Sidebar geometry (width + collapsed state) and the derived CSS grid
 * template the shell consumes. Extracted from `AppComponent` in HT-S-01 so
 * the shell is reduced to a pure layout host and so the same signals are
 * reusable from any deeply-nested component that needs to know the
 * current sidebar width (e.g. the floating toggle in HT-TB-01).
 *
 * The service owns:
 * - persisted width / collapsed flag in `localStorage`
 * - the dynamic upper bound (50 % of the viewport) and the resize listener
 * - the drag interaction model (mousedown → mousemove → mouseup), with
 *   the cursor and `user-select` overrides on `document.body`
 *
 * Lifetime: `providedIn: 'root'`, so the constructor's window resize
 * listener and the bounds-clamp effect live for the whole app.
 */
@Injectable({ providedIn: 'root' })
export class LayoutSizesService {
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  /** Default expanded width — chosen to fit the sidebar's content
   *  (pinned + projects + sessions) at the standard `--dv-fs-md` scale. */
  static readonly DEFAULT_SIDEBAR_PX = 280;
  /** Usable minimum expanded width: below this the rows would squash, so the
   *  drag collapses to the rail instead of holding a cramped sidebar. Also the
   *  hard floor the width clamps to while expanded. */
  static readonly MIN_SIDEBAR_PX = 168;
  /** Collapsed rail width: the sidebar shrinks to this instead of vanishing,
   *  leaving just enough room for the in-rail expand button. */
  static readonly RAIL_PX = 40;
  /** Grid track size of the vertical splitter between sidebar and chat. */
  static readonly SPLITTER_PX = 6;

  private static readonly SIDEBAR_WIDTH_KEY = 'devia:sidebar:widthPx';
  private static readonly SIDEBAR_COLLAPSED_KEY = 'devia:sidebar:collapsed';

  private readonly _sidebarWidthPx = signal<number>(this.loadSidebarWidth());
  private readonly _sidebarCollapsed = signal<boolean>(this.loadSidebarCollapsed());
  private readonly _isResizingSidebar = signal(false);
  private readonly _viewportWidth = signal<number>(
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  );

  readonly sidebarWidthPx = this._sidebarWidthPx.asReadonly();
  readonly sidebarCollapsed = this._sidebarCollapsed.asReadonly();
  readonly isResizingSidebar = this._isResizingSidebar.asReadonly();

  /** Dynamic upper bound: 50 % of the current viewport, never below the
   *  hard floor. Re-evaluates on every window resize. */
  readonly maxSidebarPx = computed(() =>
    Math.max(
      LayoutSizesService.MIN_SIDEBAR_PX,
      Math.floor(this._viewportWidth() * 0.5),
    ),
  );

  /**
   * Grid template applied to `.dsm-main`. The first track is the sidebar
   * (or `0px` when collapsed so the chat reclaims the space), the second
   * is the vertical splitter, the third is the chat outlet, the fourth
   * is the right-rail's `auto` reservation.
   *
   * `minmax(0, 1fr)` on the chat column lets it actually shrink — a bare
   * `1fr` has `min-width: auto` which would let an over-eager `<pre>` push
   * the track beyond the viewport and look clipped.
   */
  readonly mainGridTemplate = computed(() => {
    const splitter = `${LayoutSizesService.SPLITTER_PX}px`;
    const sidebar = this._sidebarCollapsed()
      ? `${LayoutSizesService.RAIL_PX}px`
      : `${this._sidebarWidthPx()}px`;
    return `${sidebar} ${splitter} minmax(0, 1fr) auto`;
  });

  constructor() {
    if (typeof window !== 'undefined') {
      const onResize = () => this._viewportWidth.set(window.innerWidth);
      window.addEventListener('resize', onResize);
      this.destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));
    }

    // Clamp the persisted width back into bounds when the viewport
    // shrinks. Without this, dragging the window down could leave the
    // sidebar wider than the new max and squeeze the chat column to zero.
    effect(
      () => {
        const max = this.maxSidebarPx();
        if (this._sidebarWidthPx() > max) {
          this._sidebarWidthPx.set(max);
        }
      },
      { injector: this.injector },
    );
  }

  toggleSidebarCollapse(): void {
    const next = !this._sidebarCollapsed();
    this._sidebarCollapsed.set(next);
    this.persistCollapsed(next);
  }

  resetSidebarWidth(): void {
    if (this._sidebarCollapsed()) {
      this._sidebarCollapsed.set(false);
      this.persistCollapsed(false);
    }
    this._sidebarWidthPx.set(LayoutSizesService.DEFAULT_SIDEBAR_PX);
    this.persistWidth(LayoutSizesService.DEFAULT_SIDEBAR_PX);
  }

  /**
   * Begin a sidebar resize gesture. Wires `mousemove` and `mouseup`
   * listeners on `document` (not the splitter element) so the drag keeps
   * tracking even when the cursor leaves the 6px handle, and restores
   * the body's cursor + user-select on release.
   */
  startSidebarDrag(event: MouseEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    // Anchor the gesture at the current width, or at the usable minimum when
    // starting from a collapsed rail so dragging right expands smoothly and
    // dragging left keeps it collapsed.
    const startWidth = this._sidebarCollapsed()
      ? LayoutSizesService.MIN_SIDEBAR_PX
      : this._sidebarWidthPx();
    // Width to restore on re-open if the drag ends collapsed.
    const reopenWidth = this._sidebarCollapsed()
      ? this._sidebarWidthPx()
      : startWidth;

    this._isResizingSidebar.set(true);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e: MouseEvent) => {
      const next = startWidth + (e.clientX - startX);
      // Narrower than the usable minimum → collapse to the rail instead of
      // squashing the rows. Keep the pre-drag width so re-opening restores it.
      if (next < LayoutSizesService.MIN_SIDEBAR_PX) {
        if (!this._sidebarCollapsed()) {
          this._sidebarCollapsed.set(true);
          this._sidebarWidthPx.set(reopenWidth);
        }
        return;
      }
      if (this._sidebarCollapsed()) this._sidebarCollapsed.set(false);
      this._sidebarWidthPx.set(Math.min(this.maxSidebarPx(), next));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      this._isResizingSidebar.set(false);
      this.persistCollapsed(this._sidebarCollapsed());
      if (!this._sidebarCollapsed()) this.persistWidth(this._sidebarWidthPx());
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /** Test seam — `KeyboardShortcutsService` (HT-S-01) uses this to
   *  trigger the same effect as a user clicking the toggle. */
  setViewportWidthForTesting(width: number): void {
    this._viewportWidth.set(width);
  }

  // ── persistence ────────────────────────────────────────────────────────

  private loadSidebarWidth(): number {
    try {
      const raw = localStorage.getItem(LayoutSizesService.SIDEBAR_WIDTH_KEY);
      if (!raw) return LayoutSizesService.DEFAULT_SIDEBAR_PX;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n)) return LayoutSizesService.DEFAULT_SIDEBAR_PX;
      return Math.max(LayoutSizesService.MIN_SIDEBAR_PX, n);
    } catch {
      return LayoutSizesService.DEFAULT_SIDEBAR_PX;
    }
  }

  private loadSidebarCollapsed(): boolean {
    try {
      return localStorage.getItem(LayoutSizesService.SIDEBAR_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  private persistWidth(v: number): void {
    try {
      localStorage.setItem(
        LayoutSizesService.SIDEBAR_WIDTH_KEY,
        String(Math.round(v)),
      );
    } catch {
      /* private mode / SSR — in-memory state still holds */
    }
  }

  private persistCollapsed(v: boolean): void {
    try {
      localStorage.setItem(
        LayoutSizesService.SIDEBAR_COLLAPSED_KEY,
        v ? '1' : '0',
      );
    } catch {
      /* ignore */
    }
  }
}
