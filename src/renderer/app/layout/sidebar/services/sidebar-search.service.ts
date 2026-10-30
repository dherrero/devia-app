import { Injectable, inject, signal } from '@angular/core';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import type { ProjectEntry } from '../../../../types/devia';

/**
 * Recursive workspace search backend (HT-SB-03).
 *
 * Debouncing is owned by `ds-search-box` — the service receives queries
 * via `setQuery(...)` that are already trimmed and quiet-window-coalesced.
 * Responsibilities kept here:
 * - Single in-flight policy with a monotonic token guarding against
 *   out-of-order responses (a slow `"a"` finishing AFTER a fast `"abc"`
 *   would otherwise replace the wider result set).
 * - Empty / blank query shortcut: clears results and stops the spinner
 *   synchronously so the projects list re-shows the local nav-path.
 * - `query` read-only signal so consumers can render derived views
 *   (empty state, `dnd-back` row, etc.) without observing the input box.
 *
 * Lives in `providedIn: 'root'` because the sidebar's panels can mount /
 * unmount independently (collapse, project change) while a pending IPC
 * needs to keep its token.
 */
@Injectable({ providedIn: 'root' })
export class SidebarSearchService {
  private readonly api = inject(ElectronApiService);

  private readonly _query = signal('');
  private readonly _searching = signal(false);
  private readonly _results = signal<ProjectEntry[]>([]);

  readonly query = this._query.asReadonly();
  readonly searching = this._searching.asReadonly();
  readonly results = this._results.asReadonly();

  private searchToken = 0;

  /** Push a new query through the service. Debouncing happens upstream
   *  (in `ds-search-box`). Whitespace is trimmed defensively. */
  setQuery(raw: string): void {
    const q = raw.trim();
    if (q === this._query()) return;
    this._query.set(q);

    if (!q) {
      this._results.set([]);
      this._searching.set(false);
      this.searchToken += 1;
      return;
    }

    this._searching.set(true);
    const token = ++this.searchToken;
    void this.runSearch(q, token);
  }

  /** Reset to the empty state — called when the user navigates the
   *  folder tree so a stale match list can't leak into the new scope. */
  clear(): void {
    this.setQuery('');
  }

  private async runSearch(q: string, token: number): Promise<void> {
    try {
      const results = await this.api.searchProjects(q);
      if (token !== this.searchToken) return;
      this._results.set(results);
    } catch (err) {
      console.error('[search] failed:', err);
      if (token === this.searchToken) this._results.set([]);
    } finally {
      if (token === this.searchToken) this._searching.set(false);
    }
  }
}
