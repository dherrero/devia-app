import { DestroyRef, Injectable, inject } from '@angular/core';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { AppStateService } from '../services/app-state.service';
import { RightRailStateService } from '../../layout/right-rail/services/right-rail-state.service';
import { LayoutSizesService } from './layout-sizes.service';
import { SettingsModalComponent } from '../../features/settings/settings-modal/settings-modal.component';

/**
 * Window-level keyboard shortcuts (HT-S-01). VS Code parity:
 *
 * | Chord                    | Action                                   |
 * |--------------------------|------------------------------------------|
 * | `Ctrl/Cmd + B`           | Toggle left sidebar                      |
 * | `Ctrl/Cmd + J`           | Toggle right-rail terminal pane          |
 * | `Ctrl/Cmd + Shift + E`   | Toggle right-rail tree pane              |
 * | `Ctrl/Cmd + ,`           | Open Settings                            |
 *
 * Captured at the window level so they work regardless of focus —
 * plain `<input>`/`<textarea>` don't use these chords, and the few
 * rich-text surfaces in the app (xterm.js, code editors) handle their
 * own.
 *
 * `init()` must be called once during AppComponent bootstrap. The
 * listener is teardown-safe via the application-root `DestroyRef`.
 */
@Injectable({ providedIn: 'root' })
export class KeyboardShortcutsService {
  private readonly state = inject(AppStateService);
  private readonly layout = inject(LayoutSizesService);
  private readonly rightRail = inject(RightRailStateService);
  private readonly dialog = inject(Dialog);
  private readonly destroyRef = inject(DestroyRef);

  private wired = false;
  private settingsRef: DialogRef<unknown, SettingsModalComponent> | null = null;

  /** Idempotent — safe to call from `AppComponent.ngOnInit`. */
  init(): void {
    if (this.wired || typeof window === 'undefined') return;
    this.wired = true;
    const handler = (e: KeyboardEvent) => this.handle(e);
    window.addEventListener('keydown', handler);
    this.destroyRef.onDestroy(() => window.removeEventListener('keydown', handler));
  }

  /** Exposed for tests so we can fire a synthesized event without wiring
   *  the global listener twice in jsdom. */
  handle(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.altKey) return;
    const key = e.key.toLowerCase();

    if (!e.shiftKey && key === 'b') {
      e.preventDefault();
      this.layout.toggleSidebarCollapse();
      return;
    }
    // Right-rail shortcuts are only meaningful when a project is
    // selected — the rail is gated by @if and won't be in the DOM
    // otherwise, so a keystroke without a project is a quiet no-op.
    if (!e.shiftKey && key === 'j') {
      e.preventDefault();
      // S-13 T-158: the Terminal tab is unavailable while a split is active
      // (the terminal runs on the base project, ambiguous with 2+ panes).
      if (this.state.selectedProject() && !this.state.splitActive()) this.rightRail.toggleTab('terminal');
      return;
    }
    if (e.shiftKey && key === 'e') {
      e.preventDefault();
      if (this.state.selectedProject()) this.rightRail.toggleTab('tree');
      return;
    }
    if (!e.shiftKey && key === ',') {
      e.preventDefault();
      this.openSettings();
    }
  }

  private openSettings(): void {
    if (this.settingsRef) return;
    this.settingsRef = this.dialog.open(SettingsModalComponent, {
      width: 'min(54rem, calc(100vw - 2rem))',
      maxWidth: 'calc(100vw - 2rem)',
      height: 'min(36rem, calc(100vh - 2rem))',
      maxHeight: 'calc(100vh - 2rem)',
      panelClass: 'dv-dialog-panel',
      backdropClass: 'dv-dialog-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    this.settingsRef.closed.subscribe(() => {
      this.settingsRef = null;
    });
  }
}
