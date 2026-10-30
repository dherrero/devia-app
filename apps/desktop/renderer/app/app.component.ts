import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { DialogService } from '@devia/ui';
import { TranslateService } from '@ngx-translate/core';
import { AppStateService } from './core/services/app-state.service';
import { ElectronApiService } from './core/services/electron-api.service';
import { I18nService } from './core/i18n/i18n.service';
import { QueueService } from './features/chat/queue/services/queue.service';
import { TitlebarComponent } from './layout/titlebar/titlebar.component';
import { SidebarComponent } from './layout/sidebar/sidebar.component';
import { StatusbarComponent } from './layout/statusbar/statusbar.component';
import { ToastsComponent } from './layout/toasts/toasts.component';
import { ToastService } from './core/services/toast.service';
import { UpgradeToastComponent } from './layout/upgrade/upgrade-toast.component';
import { UpgradeToastService } from './layout/upgrade/services/upgrade-toast.service';
import { RightRailComponent } from './layout/right-rail/right-rail.component';
import { KanbanStateService } from './features/kanban/services/kanban-state.service';
import { BootstrapModalComponent } from './features/kanban/components/bootstrap-modal/bootstrap-modal.component';
import { WorkspaceModalComponent } from './features/settings/workspace-modal/workspace-modal.component';
import { SettingsModalComponent } from './features/settings/settings-modal/settings-modal.component';
import { SessionImportModalComponent } from './features/session-import/session-import-modal.component';
import { CreateProjectModalComponent } from './features/projects/create-project-modal/create-project-modal.component';
import { BasesEditorModalComponent } from './features/settings/bases-editor-modal/bases-editor-modal.component';
import { StatusModalComponent } from './features/settings/status-modal/status-modal.component';
import { SplashScreenComponent } from './layout/splash/splash-screen.component';
import { LayoutSizesService } from './core/layout/layout-sizes.service';
import { KeyboardShortcutsService } from './core/layout/keyboard-shortcuts.service';
import { contextAlertBand } from '../../shared/domain/context-budget';
import type { UpdateStatus } from '../types/devia';

/**
 * Top-level shell (HT-S-01). Renders the titlebar / main / statusbar grid
 * and wires titlebar outputs to modal openers. Sidebar geometry lives in
 * `LayoutSizesService` and global chords in `KeyboardShortcutsService`.
 */
@Component({
  selector: 'ds-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterOutlet,
    TitlebarComponent,
    SidebarComponent,
    StatusbarComponent,
    ToastsComponent,
    UpgradeToastComponent,
    RightRailComponent,
    SplashScreenComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  readonly state = inject(AppStateService);
  readonly layout = inject(LayoutSizesService);
  private readonly shortcuts = inject(KeyboardShortcutsService);
  private readonly api = inject(ElectronApiService);
  private readonly router = inject(Router);
  private readonly queue = inject(QueueService);
  private readonly cdkDialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly kanban = inject(KanbanStateService);

  // Eager instantiation: each `providedIn: 'root'` service is otherwise
  // lazy. UpgradeToastService and I18nService own window listeners that
  // must be live before any feature emits; DialogService keeps the
  // @devia/ui overlay providers warm.
  private readonly upgradeToast = inject(UpgradeToastService);
  private readonly i18n = inject(I18nService);
  private readonly dialog = inject(DialogService);

  private bootstrapInFlight: string | null = null;
  private engramWarnDone = false;
  private sessionImportPromptDone = false;
  private readonly contextWarned = new Set<string>();
  private workspaceOpen = false;
  private readonly currentUrl = signal(this.router.url);

  readonly isKanbanRoute = computed(() => this.currentUrl().startsWith('/kanban'));
  readonly mainGridTemplate = computed(() =>
    this.isKanbanRoute() ? 'minmax(0, 1fr)' : this.layout.mainGridTemplate(),
  );

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((event) => this.currentUrl.set(event.urlAfterRedirects));

    effect(() => {
      const cfg = this.state.config();
      if (cfg && !cfg.hasWorkspace) this.openWorkspaceOnce();
    });

    // S-1: once the splash is gone, warn (once per launch) when engram
    // is installed AND Devia memory is enabled AND the engram MCP block
    // is OFF. Runs in an effect so it fires reactively once appReady +
    // engram detection + config have all settled.
    effect(() => {
      const cfg = this.state.config();
      const ready = this.state.appReady();
      const engram = this.state.engramInstalled();
      if (
        ready &&
        cfg &&
        cfg.memory?.enabled === true &&
        cfg.memory?.blockExternalMemory === false &&
        engram
      ) {
        this.warnEngramOnce();
      }
    });

    // Warn once per threshold crossing when the active session is close
    // to context compression. Re-arm only after usage drops below the
    // hysteresis exit band.
    effect(() => {
      const project = this.state.selectedProject();
      const pct = this.state.contextPct();
      if (!project || pct === null) return;
      const band = contextAlertBand(pct);
      if (band === 'enter') this.warnContextOnce(project);
      else if (band === 'exit') this.contextWarned.delete(project);
    });

    // E-DSK-12: react to project changes — load the kanban board and,
    // on first contact, offer the bootstrap modal.
    effect(() => {
      const project = this.state.selectedProject();
      void this.onProjectChanged(project);
    });

    // S-18: once the workspace is configured, offer (one time per install) to
    // import pre-existing Claude Code sessions when any map to the workspace.
    effect(() => {
      const cfg = this.state.config();
      const ready = this.state.appReady();
      if (ready && cfg?.hasWorkspace) void this.maybePromptSessionImport();
    });
  }

  ngOnInit() {
    this.queue.init();
    this.state.init();
    this.shortcuts.init();
    // Auto-update: surface a toast when a release is downloading / ready.
    this.api.onUpdateStatus((s) => this.onUpdateStatus(s));
  }

  private onUpdateStatus(s: UpdateStatus) {
    if (s.state === 'available') {
      this.toast.show(
        this.translate.instant('toasts.update_downloading', { version: s.version ?? '' }),
        { kind: 'info' },
      );
    } else if (s.state === 'downloaded') {
      this.toast.show(
        this.translate.instant('toasts.update_ready', { version: s.version ?? '' }),
        {
          kind: 'success',
          durationMs: 60_000,
          action: {
            label: this.translate.instant('toasts.update_restart'),
            onAction: () => void this.api.installUpdate(),
          },
        },
      );
    }
  }

  // ── Titlebar actions ───────────────────────────────────────────────────

  openStatus() {
    this.cdkDialog.open(StatusModalComponent, {
      maxWidth: 'calc(100vw - 2rem)',
      maxHeight: '80vh',
      panelClass: 'dv-dialog-panel',
      backdropClass: 'dv-dialog-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
  }

  openNewProject() {
    this.cdkDialog.open(CreateProjectModalComponent, {
      maxWidth: 'calc(100vw - 2rem)',
      maxHeight: '34rem',
      panelClass: 'dv-dialog-panel',
      backdropClass: 'dv-dialog-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
  }

  openBasesEditor() {
    this.cdkDialog.open(BasesEditorModalComponent, {
      maxWidth: 'calc(100vw - 2rem)',
      maxHeight: '34rem',
      panelClass: 'dv-dialog-panel',
      backdropClass: 'dv-dialog-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
  }

  openSettings(section?: string) {
    this.cdkDialog.open(SettingsModalComponent, {
      width: 'min(54rem, calc(100vw - 2rem))',
      maxWidth: 'calc(100vw - 2rem)',
      height: 'min(36rem, calc(100vh - 2rem))',
      maxHeight: 'calc(100vh - 2rem)',
      panelClass: 'dv-dialog-panel',
      backdropClass: 'dv-dialog-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      ...(section ? { data: { section } } : {}),
    });
  }

  stopAll() {
    this.api.stopAll();
  }

  // ── Side-effect bootstraps ─────────────────────────────────────────────

  /**
   * E-DSK-12 — sync the kanban state to the active project and, on
   * first contact (never bootstrapped this session), offer the bootstrap
   * modal. Re-entrancy-guarded so a project switch can't stack modals.
   */
  private async onProjectChanged(project: string | null): Promise<void> {
    await this.kanban.onProjectSelected(project);
    if (!project || this.bootstrapInFlight === project) return;
    this.bootstrapInFlight = project;
    try {
      const view = await this.kanban.checkBootstrap(project);
      // Only auto-offer the bootstrap on a genuine first contact: a NEW
      // (empty) project we've never chatted in. Existing projects — and
      // any project with prior Devia history — get the opt-in "Preparar
      // proyecto" entry in the Kanban panel instead.
      const hasHistory = (this.state.chats().get(project)?.length ?? 0) > 0;
      // Conversation started → flip the persisted `newProject` flag so a
      // later "Preparar proyecto" treats the project as existing (SDD-F1).
      if (hasHistory) void this.api.sddMarkEngaged(project);
      if (
        view &&
        view.classification === 'new' &&
        !hasHistory &&
        this.state.selectedProject() === project
      ) {
        this.cdkDialog.open(BootstrapModalComponent, {
          maxWidth: 'calc(100vw - 1.5rem)',
          maxHeight: '80vh',
          panelClass: 'dv-dialog-panel',
          backdropClass: 'dv-dialog-backdrop',
          autoFocus: 'first-tabbable',
          restoreFocus: true,
          disableClose: true,
          data: { project, view },
        });
      }
    } finally {
      if (this.bootstrapInFlight === project) this.bootstrapInFlight = null;
    }
  }

  private openWorkspaceOnce() {
    if (this.workspaceOpen) return;
    this.workspaceOpen = true;
    const ref = this.cdkDialog.open(WorkspaceModalComponent, {
      maxWidth: 'calc(100vw - 2rem)',
      panelClass: 'dv-dialog-panel',
      backdropClass: 'dv-dialog-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      disableClose: true,
    });
    ref.closed.subscribe(() => {
      this.workspaceOpen = false;
    });
  }

  /** S-20 first-run prompt. Guarded by a localStorage flag so it shows at most
   *  once per install, and only when agent sessions actually map to the
   *  workspace. The flag is set the moment we decide to act, regardless of the
   *  user's choice, so it never reappears. */
  private async maybePromptSessionImport(): Promise<void> {
    if (this.sessionImportPromptDone) return;
    this.sessionImportPromptDone = true;
    const KEY = 'devia.sessionImportPrompted';
    try {
      if (localStorage.getItem(KEY) === '1') return;
    } catch { /* localStorage unavailable — fall through, scan still gated below */ }

    let agents: Awaited<ReturnType<typeof this.api.scanSessionImport>>;
    try {
      agents = await this.api.scanSessionImport();
    } catch {
      return;
    }
    const hasSessions = agents.some((a) => a.projects.some((p) => p.sessions.length > 0));
    try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ }
    if (!hasSessions) return;

    this.toast.show(this.translate.instant('toasts.session_import_offer'), {
      kind: 'info',
      durationMs: 15_000,
      action: {
        label: this.translate.instant('toasts.session_import_action'),
        onAction: () => this.openSessionImport(),
      },
    });
  }

  openSessionImport(): void {
    this.cdkDialog.open(SessionImportModalComponent, {
      width: 'min(46rem, calc(100vw - 2rem))',
      maxWidth: 'calc(100vw - 2rem)',
      height: 'min(34rem, calc(100vh - 2rem))',
      maxHeight: 'calc(100vh - 2rem)',
      panelClass: 'dv-dialog-panel',
      backdropClass: 'dv-dialog-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
  }

  private warnEngramOnce(): void {
    if (this.engramWarnDone) return;
    this.engramWarnDone = true;
    this.toast.show(this.translate.instant('toasts.engram_active_warning'), {
      kind: 'warning',
      durationMs: 12_000,
      onClick: () => this.openSettings('memory'),
    });
  }

  private warnContextOnce(project: string): void {
    if (this.contextWarned.has(project)) return;
    this.contextWarned.add(project);
    this.toast.show(this.translate.instant('toasts.context_high_warning'), {
      kind: 'warning',
      durationMs: 10_000,
    });
  }
}
