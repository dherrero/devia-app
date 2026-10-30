/**
 * Split-view layout model (S-13 T-143).
 *
 * Pure, side-effect-free model for the multi-session split view: up to a 2×2
 * grid of chat panes (max 4). The container component (T-143 UI, pending) keeps
 * one `PanesLayout` in a signal and drives it through these pure transitions, so
 * the layout logic + the split-icon state machine are unit-testable without the
 * DOM, Angular, or the worktree backend.
 *
 * Geometry: `columns` (1–2), each `Column` holds `panes` rows (1–2). Reachable
 * shapes: 1 (full) · 2 (two columns) · 3 (one column split into two rows + one
 * full column) · 4 (2×2 grid).
 */
import type { SessionRef } from '../../../../../shared/domain/session-ref';

export const MAX_COLUMNS = 2;
export const MAX_ROWS = 2;
export const MAX_PANES = 4;

export interface Pane {
  /** Stable id for trackBy + focus/close addressing. */
  readonly id: string;
  /** The session this pane runs (primary = project path; extra = worktree). */
  readonly sessionRef: SessionRef;
}

export interface Column {
  readonly panes: readonly Pane[];
}

export interface PanesLayout {
  readonly columns: readonly Column[];
  /** Id of the pane that currently drives the right-rail / statusbar / shortcuts. */
  readonly focusedPaneId: string;
}

/** The split affordance to render for a column's header. */
export type SplitIcon = 'vertical' | 'horizontal' | 'none';

// ── Queries ─────────────────────────────────────────────────────────────────

export function paneCount(layout: PanesLayout): number {
  return layout.columns.reduce((n, c) => n + c.panes.length, 0);
}

export function allPanes(layout: PanesLayout): Pane[] {
  return layout.columns.flatMap((c) => c.panes);
}

export function findPane(layout: PanesLayout, paneId: string): Pane | null {
  return allPanes(layout).find((p) => p.id === paneId) ?? null;
}

export function focusedPane(layout: PanesLayout): Pane | null {
  return findPane(layout, layout.focusedPaneId);
}

/**
 * The split icon for the column at `columnIndex`:
 *   - total 4 panes  → 'none' everywhere (hard cap).
 *   - single column  → 'vertical' (a second column can be opened).
 *   - 2 columns, this column has 1 row → 'horizontal' (it can split into rows).
 *   - this column already has 2 rows   → 'none'.
 */
export function splitIconFor(layout: PanesLayout, columnIndex: number): SplitIcon {
  if (paneCount(layout) >= MAX_PANES) return 'none';
  const column = layout.columns[columnIndex];
  if (!column) return 'none';
  if (layout.columns.length < MAX_COLUMNS) return 'vertical';
  return column.panes.length < MAX_ROWS ? 'horizontal' : 'none';
}

// ── Constructors ────────────────────────────────────────────────────────────

/** A fresh single-pane layout (the primary session over the real repo). */
export function singlePaneLayout(primary: Pane): PanesLayout {
  return { columns: [{ panes: [primary] }], focusedPaneId: primary.id };
}

// ── Transitions (pure — always return a new layout) ─────────────────────────

/**
 * Open a second column to the right with `newPane`. No-op (returns the same
 * layout) when already at 2 columns or at the 4-pane cap. The new pane gains
 * focus.
 */
export function splitVertical(layout: PanesLayout, newPane: Pane): PanesLayout {
  if (layout.columns.length >= MAX_COLUMNS) return layout;
  if (paneCount(layout) >= MAX_PANES) return layout;
  return {
    columns: [...layout.columns, { panes: [newPane] }],
    focusedPaneId: newPane.id,
  };
}

/**
 * Split the column at `columnIndex` into two rows: the existing pane(s) on top,
 * `newPane` below. No-op when that column already has 2 rows or at the 4-pane
 * cap. The new pane gains focus.
 */
export function splitHorizontal(
  layout: PanesLayout,
  columnIndex: number,
  newPane: Pane,
): PanesLayout {
  if (paneCount(layout) >= MAX_PANES) return layout;
  const column = layout.columns[columnIndex];
  if (!column || column.panes.length >= MAX_ROWS) return layout;
  const columns = layout.columns.map((c, i) =>
    i === columnIndex ? { panes: [...c.panes, newPane] } : c,
  );
  return { columns, focusedPaneId: newPane.id };
}

/**
 * Remove a pane and recompose: empty columns are dropped so a 2-column layout
 * collapses back to a single column (re-enabling the vertical split icon). When
 * the focused pane is removed, focus moves to the first remaining pane. Removing
 * the last pane is a no-op (the layout always keeps at least one pane — the
 * caller never closes the primary anchor; see the close flow in the container).
 */
export function closePane(layout: PanesLayout, paneId: string): PanesLayout {
  if (paneCount(layout) <= 1) return layout;
  const columns = layout.columns
    .map((c) => ({ panes: c.panes.filter((p) => p.id !== paneId) }))
    .filter((c) => c.panes.length > 0);
  if (columns.length === layout.columns.length &&
      paneCount({ columns, focusedPaneId: '' }) === paneCount(layout)) {
    return layout; // paneId not found — nothing changed
  }
  const stillFocused = columns.some((c) => c.panes.some((p) => p.id === layout.focusedPaneId));
  const focusedPaneId = stillFocused
    ? layout.focusedPaneId
    : (columns[0]?.panes[0]?.id ?? '');
  return { columns, focusedPaneId };
}

/** Move focus to `paneId` (no-op if it does not exist). */
export function focusPane(layout: PanesLayout, paneId: string): PanesLayout {
  if (!findPane(layout, paneId)) return layout;
  return { ...layout, focusedPaneId: paneId };
}

/** True when no further split is possible (4 panes mounted). */
export function isFull(layout: PanesLayout): boolean {
  return paneCount(layout) >= MAX_PANES;
}
