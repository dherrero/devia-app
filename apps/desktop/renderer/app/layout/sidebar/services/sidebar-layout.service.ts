import { Injectable, computed, signal } from '@angular/core';

/** Anchored at the corner of an element rectangle the splitter is
 *  resizing against. Both heights are in CSS pixels. */
export interface SplitterDragHandles {
  /** Height of the panel the drag is anchored on (Fijados or Sesiones). */
  readonly anchorHeightPx: number;
  /** Combined height of the anchor panel plus its neighbour (Projects). */
  readonly combinedHeightPx: number;
}

/** Direction of the gesture relative to the drag delta. */
export type SplitterAxis = 'forward' | 'inverse';

/**
 * Sidebar geometry + persistence (HT-SB-01).
 *
 * Owns the two horizontal splitters inside the sidebar (Fijados ↔ Proyectos
 * and Proyectos ↔ Sesiones) and the collapsed state of the Sesiones panel.
 * The component still calls into `startSplitterDrag(...)` with element
 * rectangles measured at the moment the gesture starts — the service has
 * no DOM access of its own, which keeps it testable.
 *
 * Persistence keys preserve their legacy names so existing users keep
 * their layout across the upgrade.
 */
@Injectable({ providedIn: 'root' })
export class SidebarLayoutService {
  static readonly MIN_SECTION_PX = 56;
  static readonly DEFAULT_SESSIONS_PX = 240;

  private static readonly PINNED_HEIGHT_KEY = 'devia:sidebar:pinnedHeightPx';
  private static readonly SESSIONS_HEIGHT_KEY = 'devia:sidebar:sessionsHeightPx';
  private static readonly SESSIONS_COLLAPSED_KEY = 'devia:sidebar:sessionsCollapsed';
  private static readonly PINNED_COLLAPSED_KEY = 'devia:sidebar:pinnedCollapsed';
  private static readonly PROJECTS_COLLAPSED_KEY = 'devia:sidebar:projectsCollapsed';

  // ── State signals ─────────────────────────────────────────────────────

  /** `null` = use the default 1fr/1fr split; a number pins Fijados at a
   *  specific px height and Projects consumes the rest. */
  private readonly _pinnedHeightPx = signal<number | null>(this.loadPinnedHeight());
  /** Sesiones panel height in px. Defaults to the historical 240 px. */
  private readonly _sessionsHeightPx = signal<number>(this.loadSessionsHeight());
  private readonly _sessionsCollapsed = signal<boolean>(this.loadSessionsCollapsed());
  private readonly _pinnedCollapsed = signal<boolean>(this.loadCollapsed(SidebarLayoutService.PINNED_COLLAPSED_KEY));
  private readonly _projectsCollapsed = signal<boolean>(this.loadCollapsed(SidebarLayoutService.PROJECTS_COLLAPSED_KEY));
  private readonly _isResizingPinned = signal(false);
  private readonly _isResizingSessions = signal(false);

  readonly pinnedHeightPx = this._pinnedHeightPx.asReadonly();
  readonly sessionsHeightPx = this._sessionsHeightPx.asReadonly();
  readonly sessionsCollapsed = this._sessionsCollapsed.asReadonly();
  readonly pinnedCollapsed = this._pinnedCollapsed.asReadonly();
  readonly projectsCollapsed = this._projectsCollapsed.asReadonly();
  readonly isResizingPinned = this._isResizingPinned.asReadonly();
  readonly isResizingSessions = this._isResizingSessions.asReadonly();

  /** CSS flex value driven by the persisted pinned height. Collapsing the
   *  panel shrinks it to just its header. */
  readonly pinnedFlex = computed(() => {
    if (this._pinnedCollapsed()) return '0 0 auto';
    const h = this._pinnedHeightPx();
    return h === null ? '1 1 0' : `0 0 ${h}px`;
  });

  readonly projectsFlex = computed(() =>
    this._projectsCollapsed() ? '0 0 auto' : '1 1 0',
  );

  readonly sessionsFlex = computed(() => {
    if (this._sessionsCollapsed()) return '0 0 auto';
    return `0 0 ${this._sessionsHeightPx()}px`;
  });

  // ── Actions ───────────────────────────────────────────────────────────

  toggleSessionsCollapsed(): void {
    const next = !this._sessionsCollapsed();
    this._sessionsCollapsed.set(next);
    this.persist(SidebarLayoutService.SESSIONS_COLLAPSED_KEY, next ? '1' : '0');
  }

  togglePinnedCollapsed(): void {
    const next = !this._pinnedCollapsed();
    this._pinnedCollapsed.set(next);
    this.persist(SidebarLayoutService.PINNED_COLLAPSED_KEY, next ? '1' : '0');
  }

  toggleProjectsCollapsed(): void {
    const next = !this._projectsCollapsed();
    this._projectsCollapsed.set(next);
    this.persist(SidebarLayoutService.PROJECTS_COLLAPSED_KEY, next ? '1' : '0');
  }

  resetPinnedSplitter(): void {
    this._pinnedHeightPx.set(null);
    this.remove(SidebarLayoutService.PINNED_HEIGHT_KEY);
  }

  resetSessionsSplitter(): void {
    this._sessionsHeightPx.set(SidebarLayoutService.DEFAULT_SESSIONS_PX);
    this.remove(SidebarLayoutService.SESSIONS_HEIGHT_KEY);
  }

  /**
   * Begin a Fijados ↔ Proyectos drag. The caller passes the measured
   * heights so the service stays DOM-free.
   *
   * Dragging the handle DOWN expands Fijados (`axis: 'forward'`). The
   * Sesiones splitter uses `axis: 'inverse'` because dragging DOWN must
   * shrink the panel BELOW the handle.
   */
  startPinnedDrag(event: MouseEvent, handles: SplitterDragHandles): void {
    this.runDrag({
      event,
      handles,
      axis: 'forward',
      isResizing: this._isResizingPinned,
      onUpdate: (px) => this._pinnedHeightPx.set(px),
      onCommit: (px) =>
        this.persist(SidebarLayoutService.PINNED_HEIGHT_KEY, String(Math.round(px))),
    });
  }

  startSessionsDrag(event: MouseEvent, handles: SplitterDragHandles): void {
    this.runDrag({
      event,
      handles,
      axis: 'inverse',
      isResizing: this._isResizingSessions,
      onUpdate: (px) => this._sessionsHeightPx.set(px),
      onCommit: (px) =>
        this.persist(SidebarLayoutService.SESSIONS_HEIGHT_KEY, String(Math.round(px))),
    });
  }

  /** Test seam — flips the collapsed flag without persisting. */
  setSessionsCollapsedForTesting(collapsed: boolean): void {
    this._sessionsCollapsed.set(collapsed);
  }

  // ── Shared drag mechanic ──────────────────────────────────────────────

  private runDrag(opts: {
    event: MouseEvent;
    handles: SplitterDragHandles;
    axis: SplitterAxis;
    isResizing: ReturnType<typeof signal<boolean>>;
    onUpdate: (px: number) => void;
    onCommit: (px: number) => void;
  }): void {
    const { event, handles, axis, isResizing, onUpdate, onCommit } = opts;
    if (event.button !== 0) return;
    event.preventDefault();

    const startY = event.clientY;
    const startHeight = handles.anchorHeightPx;
    const max = Math.max(
      SidebarLayoutService.MIN_SECTION_PX,
      handles.combinedHeightPx - SidebarLayoutService.MIN_SECTION_PX,
    );

    isResizing.set(true);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    let lastValue = startHeight;
    const onMove = (e: MouseEvent) => {
      const delta = e.clientY - startY;
      const next = axis === 'forward' ? startHeight + delta : startHeight - delta;
      const clamped = Math.max(SidebarLayoutService.MIN_SECTION_PX, Math.min(max, next));
      lastValue = clamped;
      onUpdate(clamped);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      isResizing.set(false);
      onCommit(lastValue);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ── Persistence ───────────────────────────────────────────────────────

  private loadPinnedHeight(): number | null {
    try {
      const raw = localStorage.getItem(SidebarLayoutService.PINNED_HEIGHT_KEY);
      if (!raw) return null;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  private loadSessionsHeight(): number {
    try {
      const raw = localStorage.getItem(SidebarLayoutService.SESSIONS_HEIGHT_KEY);
      if (!raw) return SidebarLayoutService.DEFAULT_SESSIONS_PX;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n >= SidebarLayoutService.MIN_SECTION_PX
        ? n
        : SidebarLayoutService.DEFAULT_SESSIONS_PX;
    } catch {
      return SidebarLayoutService.DEFAULT_SESSIONS_PX;
    }
  }

  private loadSessionsCollapsed(): boolean {
    return this.loadCollapsed(SidebarLayoutService.SESSIONS_COLLAPSED_KEY);
  }

  private loadCollapsed(key: string): boolean {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  }

  private persist(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode / ssr — in-memory state still holds */
    }
  }

  private remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}
