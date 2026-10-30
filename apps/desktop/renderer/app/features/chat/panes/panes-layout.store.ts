import { Injectable } from '@angular/core';
import type { PanesLayout } from './panes-layout.model';

/**
 * Skeleton of a split layout persisted across app restarts (S-3 F2.3). Only
 * the reconstructible bits are stored: the column×row arrangement and each
 * additional pane's sessionId (`null` = the primary pane). Workdir/branch are
 * NOT serialized — the restore path re-resolves them through the adoption
 * recovery chain (F2.2), which is the source of truth for recovery.
 */
export interface PersistedPanesSkeleton {
  columns: Array<{ panes: Array<string | null> }>;
  /** sessionId of the focused pane; null = primary. */
  focusedSessionId: string | null;
}

const SKELETON_KEY_PREFIX = 'devia.panesLayout.';

/**
 * Store of the split-view layout per base project (S-13 T-143).
 *
 * Root-scoped on purpose: the `ChatPanesContainerComponent` is destroyed and
 * recreated whenever the user leaves the chat route (e.g. opens the Kanban) and
 * comes back. Keeping the per-project layouts in a root singleton lets the
 * container restore the exact split — panes, focus, session identities — on
 * re-creation, so navigating anywhere in the app never loses the split.
 *
 * S-3 F2.3: a SKELETON of every committed layout also lands in localStorage so
 * a full app restart can rebuild the split (sessions re-resolved through the
 * adoption recovery chain). Live `PanesLayout` objects stay memory-only.
 */
@Injectable({ providedIn: 'root' })
export class PanesLayoutStore {
  private readonly byProject = new Map<string, PanesLayout>();

  get(projectKey: string): PanesLayout | undefined {
    return this.byProject.get(projectKey);
  }

  set(projectKey: string, layout: PanesLayout): void {
    this.byProject.set(projectKey, layout);
    this.saveSkeleton(projectKey, layout);
  }

  delete(projectKey: string): void {
    this.byProject.delete(projectKey);
  }

  /** Persist the reconstructible skeleton of `layout` (S-3 F2.3). */
  private saveSkeleton(projectKey: string, layout: PanesLayout): void {
    try {
      const focused = layout.columns
        .flatMap((c) => c.panes)
        .find((p) => p.id === layout.focusedPaneId);
      const skeleton: PersistedPanesSkeleton = {
        columns: layout.columns.map((c) => ({
          panes: c.panes.map((p) => (p.id === 'primary' ? null : p.sessionRef.sessionId)),
        })),
        focusedSessionId: focused && focused.id !== 'primary' ? focused.sessionRef.sessionId : null,
      };
      localStorage.setItem(SKELETON_KEY_PREFIX + projectKey, JSON.stringify(skeleton));
    } catch {
      /* quota/serialization issues must never break a layout commit */
    }
  }

  /** Read a persisted skeleton, or null when absent/malformed/single-pane. */
  readSkeleton(projectKey: string): PersistedPanesSkeleton | null {
    try {
      const raw = localStorage.getItem(SKELETON_KEY_PREFIX + projectKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedPanesSkeleton;
      if (!Array.isArray(parsed.columns)) return null;
      const columns = parsed.columns
        .slice(0, 2)
        .map((c) => ({
          panes: (Array.isArray(c?.panes) ? c.panes : [])
            .slice(0, 2)
            .filter((s): s is string | null => s === null || typeof s === 'string'),
        }))
        .filter((c) => c.panes.length > 0);
      const total = columns.reduce((n, c) => n + c.panes.length, 0);
      if (total <= 1) return null; // single pane — nothing to restore
      return {
        columns,
        focusedSessionId: typeof parsed.focusedSessionId === 'string' ? parsed.focusedSessionId : null,
      };
    } catch {
      return null;
    }
  }

  clearSkeleton(projectKey: string): void {
    try {
      localStorage.removeItem(SKELETON_KEY_PREFIX + projectKey);
    } catch {
      /* ignore */
    }
  }
}
