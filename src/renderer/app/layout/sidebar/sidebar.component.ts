import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Dialog } from '@angular/cdk/dialog';
import {
  ButtonComponent,
  DialogService,
  IconComponent,
  MenuComponent,
  MenuTriggerDirective,
  TooltipDirective,
  type MenuItemDef,
} from '@devia/ui';
import {
  LucideArrowLeft,
  LucideChevronDown,
  LucideChevronLeft,
  LucideChevronRight,
  LucideChevronUp,
  LucideCode,
  LucideCopy,
  LucideFileEdit,
  LucideFolderOpen,
  LucideFolderPlus,
  LucidePin,
  LucidePlus,
  LucideRefreshCw,
  LucideRocket,
  LucideRotateCw,
  LucideSquare,
  LucideTrash2,
  LucideColumns2,
} from '@lucide/angular';
import {
  type LangChangeEvent,
  TranslateModule,
  TranslateService,
} from '@ngx-translate/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { AppStateService } from '../../core/services/app-state.service';
import { ElectronApiService } from '../../core/services/electron-api.service';
import { KanbanStateService } from '../../features/kanban/services/kanban-state.service';
import { ToastService } from '../../core/services/toast.service';
import { NewFolderModalComponent } from '../../features/projects/new-folder-modal/new-folder-modal.component';
import {
  RenameFolderModalComponent,
  type RenameFolderModalData,
} from '../../features/projects/rename-folder-modal/rename-folder-modal.component';
import type { ProjectEntry, SessionMeta, SkillAgent } from '../../../types/devia';
import { agentLabel } from '../../features/skills/models/skill-agents.model';
import { firstValueFrom } from 'rxjs';
import { SidebarLayoutService } from './services/sidebar-layout.service';
import { LayoutSizesService } from '../../core/layout/layout-sizes.service';
import { SidebarSearchService } from './services/sidebar-search.service';
import { SearchBoxComponent } from './components/search-box/search-box.component';
import { MenuTriggerButtonComponent } from '../../shared/components/menu-trigger-button/menu-trigger-button.component';
import { techLabel } from './utils/tech-icon';
import {
  formatSessionDate,
  leafOf as leafOfPath,
  projectSubline,
} from './utils/path-format';

/**
 * Sidebar shell (HT-SB-01 phase 1).
 *
 * Orchestrates three vertical panels — Fijados, Proyectos and Sesiones —
 * separated by draggable splitters. Geometry (panel heights, collapsed
 * state, drag mechanic) lives in `SidebarLayoutService`; the debounced
 * recursive search lives in `SidebarSearchService`; pure helpers
 * (tech-icon map, path/date formatting) live under `utils/`.
 *
 * Phase 2 will further extract pinned-panel / projects-panel / sessions-
 * panel as standalone subcomponents — each panel section is structurally
 * independent so this should be mostly mechanical once the template
 * stabilises.
 */
@Component({
  selector: 'ds-sidebar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonComponent,
    IconComponent,
    MenuComponent,
    MenuTriggerDirective,
    MenuTriggerButtonComponent,
    TranslateModule,
    TooltipDirective,
    SearchBoxComponent,
  ],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
})
export class SidebarComponent {
  // ── Lucide icon refs (kept as fields so the template stays declarative).
  readonly LucidePin = LucidePin;
  readonly LucideRefreshCw = LucideRefreshCw;
  readonly LucidePlus = LucidePlus;
  readonly LucideArrowLeft = LucideArrowLeft;
  readonly LucideChevronUp = LucideChevronUp;
  readonly LucideChevronDown = LucideChevronDown;
  readonly LucideChevronLeft = LucideChevronLeft;
  readonly LucideChevronRight = LucideChevronRight;
  readonly LucideTrash2 = LucideTrash2;
  readonly LucideColumns2 = LucideColumns2;

  readonly state = inject(AppStateService);
  readonly layout = inject(SidebarLayoutService);
  readonly sizes = inject(LayoutSizesService);
  readonly search = inject(SidebarSearchService);
  private readonly translate = inject(TranslateService);

  /** ngx-translate loads its JSON asynchronously and `instant()` is not
   *  reactive, so it returns the raw key on first read. Adapt `onLangChange`
   *  to a signal so the tooltip re-resolves once the locale file lands (and on
   *  every language switch). */
  private readonly langChange = toSignal<LangChangeEvent | undefined>(
    this.translate.onLangChange,
    { initialValue: undefined },
  );

  /** Tooltip for the collapse/expand control (mirrors the Ctrl/⌘+B chord). */
  readonly collapseTooltip = computed(() => {
    void this.langChange();
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
    const action = this.translate.instant(
      this.sizes.sidebarCollapsed() ? 'app.show_sidebar' : 'app.hide_sidebar',
    );
    return `${action} (${mod}+B)`;
  });
  private readonly api = inject(ElectronApiService);
  private readonly kanban = inject(KanbanStateService);
  private readonly dialog = inject(Dialog);
  private readonly dialogs = inject(DialogService);
  private readonly toast = inject(ToastService);

  readonly reloading = signal(false);
  readonly dragging = signal<string | null>(null);
  readonly dropTarget = signal<string | null>(null);
  readonly newProject = output<void>();

  // ── Context menu state ────────────────────────────────────────────────

  readonly ctxX = signal(0);
  readonly ctxY = signal(0);
  readonly ctxProject = signal<ProjectEntry | null>(null);
  private readonly ctxMenuRef = viewChild.required<MenuComponent>('ctxMenuComp');

  // ── ViewChildren used as element refs for the splitter drag handles. ─

  private readonly pinnedSection = viewChild<ElementRef<HTMLElement>>('pinnedSection');
  private readonly projectsSection = viewChild<ElementRef<HTMLElement>>('projectsSection');
  private readonly sessionsSection = viewChild<ElementRef<HTMLElement>>('sessionsSection');

  // ── Menus (Lucide icons — HT-SB-01 dropped the Material font). ────────

  readonly newMenuItems = computed<MenuItemDef[]>(() => {
    // Touch the config signal so the labels re-resolve on language change —
    // and, critically, defer translation to render time: instant() at
    // field-init ran before the bundle loaded and returned the raw keys.
    this.state.config();
    const t = this.translate;
    return [
      { id: 'project', label: t.instant('sidebar.menu_project'),    icon: LucideRocket },
      { id: 'folder',  label: t.instant('sidebar.menu_new_folder'), icon: LucideFolderPlus },
    ];
  });

  readonly ctxMenuItems = computed<MenuItemDef[]>(() => {
    const p = this.ctxProject();
    if (!p) return [];
    const t = this.translate;
    if (p.tech === 'folder') {
      return [
        { id: 'explorer', label: t.instant('sidebar.menu_open_explorer'), icon: LucideFolderOpen },
        { id: 'copy',     label: t.instant('sidebar.menu_copy_path'),     icon: LucideCopy },
        { id: 'rename',   label: t.instant('sidebar.menu_rename'),        icon: LucideFileEdit, dividerBefore: true },
        { id: 'trash',    label: t.instant('sidebar.menu_trash'),         icon: LucideTrash2, destructive: true, dividerBefore: true },
      ];
    }
    const items: MenuItemDef[] = [
      { id: 'explorer', label: t.instant('sidebar.menu_open_explorer'), icon: LucideFolderOpen },
      { id: 'ide',      label: t.instant('sidebar.menu_open_ide'),      icon: LucideCode },
      { id: 'copy',     label: t.instant('sidebar.menu_copy_path'),     icon: LucideCopy },
    ];
    const running = this.state.isRunning(p.path);
    if (running) {
      items.push({ id: 'stop', label: t.instant('sidebar.menu_stop_process'), icon: LucideSquare, dividerBefore: true });
    }
    items.push({ id: 'reset', label: t.instant('sidebar.menu_reset_session'), icon: LucideRotateCw, dividerBefore: !running });
    items.push({ id: 'trash', label: t.instant('sidebar.menu_trash'), icon: LucideTrash2, destructive: true, dividerBefore: true });
    return items;
  });

  // ── Derived views ─────────────────────────────────────────────────────

  /** Empty query → local nav-path projects; non-empty → recursive results
   *  fetched by `SidebarSearchService`. The search box (HT-SB-03) owns
   *  the debounce; the service owns the race protection so this stays a
   *  plain projection. */
  readonly visible = computed(() => {
    return this.search.query() ? this.search.results() : this.state.projects();
  });

  readonly activeProjectLabel = computed(() => {
    const sel = this.state.selectedProject();
    if (!sel) return '—';
    return leafOfPath(sel);
  });

  // ── Template helpers ──────────────────────────────────────────────────

  techBadge(tech: ProjectEntry['tech']): string {
    return techLabel(tech);
  }

  leafOf(path: string): string {
    return leafOfPath(path);
  }

  sublineOf(path: string): string {
    const git = this.state.pinnedGit().get(path);
    return projectSubline({
      branch: git?.branch ?? null,
      dirty: !!git?.dirty,
      msgs: this.state.chats().get(path)?.length ?? 0,
    });
  }

  formatDate(ts: number): string {
    const locale = this.translate.currentLang || 'es';
    return formatSessionDate(ts, locale);
  }

  // ── Menu wiring ───────────────────────────────────────────────────────

  onNewMenuItem(item: MenuItemDef): void {
    if (item.id === 'project') this.newProject.emit();
    else if (item.id === 'folder') this.createFolder();
  }

  onCtxItem(item: MenuItemDef): void {
    const p = this.ctxProject();
    if (!p) return;
    switch (item.id) {
      case 'explorer': this.openInExplorer(p); break;
      case 'ide':      this.openInIde(p); break;
      case 'copy':     this.copyPath(p); break;
      case 'rename':   this.renameFolder(p); break;
      case 'stop':     void this.stopProcess(p); break;
      case 'reset':    void this.resetSession(p); break;
      case 'trash':    void this.trash(p); break;
    }
  }

  // ── Project interactions ──────────────────────────────────────────────

  onClick(p: ProjectEntry): void {
    if (p.tech === 'folder') {
      this.search.clear();
      this.state.navigateInto(p.path);
    } else {
      this.state.selectProject(p.path);
    }
  }

  onContextMenu(event: MouseEvent, p: ProjectEntry): void {
    event.preventDefault();
    event.stopPropagation();
    this.ctxX.set(event.clientX);
    this.ctxY.set(event.clientY);
    this.ctxProject.set(p);
    // setTimeout(0) (macrotask) instead of queueMicrotask: on Windows the
    // mouseup that follows the right-click is still in flight when a
    // microtask runs, and the CDK overlay backdrop catches it as a
    // "click outside" and closes the menu immediately. Linux dispatches
    // the events in a different order so the bug never surfaces there.
    setTimeout(() => this.ctxMenuRef().open(), 0);
  }

  back(): void {
    this.search.clear();
    this.state.navigateBack();
  }

  // ── Drag & drop ───────────────────────────────────────────────────────

  onDragStart(event: DragEvent, p: ProjectEntry): void {
    this.dragging.set(p.path);
    event.dataTransfer?.setData('text/plain', p.path);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  onDragEnd(): void {
    this.dragging.set(null);
    this.dropTarget.set(null);
  }

  onDragOver(event: DragEvent, targetKey: string): void {
    if (!this.dragging()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dropTarget.set(targetKey);
  }

  onDragLeave(event: DragEvent, targetKey: string): void {
    const related = event.relatedTarget as Node | null;
    if (related && (event.currentTarget as Element).contains(related)) return;
    if (this.dropTarget() === targetKey) this.dropTarget.set(null);
  }

  async onDrop(event: DragEvent, targetKey: string): Promise<void> {
    event.preventDefault();
    const src = this.dragging();
    this.dragging.set(null);
    this.dropTarget.set(null);
    if (!src) return;

    let targetFolderPath: string;
    if (targetKey === '__parent__') {
      const nav = this.state.navPath();
      targetFolderPath = nav.split('/').slice(0, -1).join('/');
    } else {
      targetFolderPath = targetKey;
    }

    const srcParent = src.split('/').slice(0, -1).join('/');
    if (srcParent === targetFolderPath) return;

    try {
      const newPath = await this.api.moveProject(src, targetFolderPath);
      if (this.state.selectedProject() === src) {
        this.state.selectedProject.set(newPath);
      }
      const pins = this.state.pinnedPaths();
      if (pins.includes(src)) {
        const newPins = pins.map((x) => (x === src ? newPath : x));
        this.state.pinnedPaths.set(newPins);
        await this.api.setPinned(newPins);
      }
      await this.state.reloadProjects();
    } catch (err) {
      this.toast.show(
        this.translate.instant('sidebar.move_error', { error: (err as Error).message }),
        { kind: 'error', durationMs: 8000 },
      );
    }
  }

  // ── Workspace / sessions / pin actions ────────────────────────────────

  async reloadWorkspace(): Promise<void> {
    if (this.reloading()) return;
    this.reloading.set(true);
    try {
      await this.state.reloadProjects();
    } catch (err) {
      console.error('[reloadWorkspace]', err);
    } finally {
      this.reloading.set(false);
    }
  }

  switchSession(projectPath: string, sessionId: string): void {
    this.state.switchSession(projectPath, sessionId);
  }

  /** Click on a listed session — full routing (S-13 T-157 + S-2 F0.3/F5.2):
   *  1. mounted in another pane → focus that pane (allowed even mid-run) + toast.
   *  2. busy destination pane → blocked with toast (loading another session
   *     mid-run would persist the in-flight conversation into it).
   *  3. destination = primary → no-op if already active, else switchSession.
   *  4. destination = additional pane → the primary's active session bounces
   *     back (focus primary + toast); any other free session is ADOPTED into
   *     the focused pane (container consumes sessionAdoptRequest). */
  openSession(session: SessionMeta): void {
    if (this.state.isSessionMounted(session.id)) {
      if (this.state.focusedSessionKey() !== session.id) {
        this.toast.show(
          this.translate.instant('sidebar.session_in_other_pane'),
          { kind: 'warning' },
        );
      }
      this.state.requestPaneFocus(session.id);
      return;
    }
    const project = this.state.selectedProject();
    if (!project) return;
    if (!this.state.canSwitchSession(session.id).ok) {
      this.toast.show(
        this.translate.instant('sidebar.session_switch_blocked_running'),
        { kind: 'warning' },
      );
      return;
    }
    const focusedPane = this.state.focusedSessionKey();
    if (focusedPane === null) {
      if (session.isActive) return;
      this.switchSession(project, session.id);
      return;
    }
    if (session.isActive) {
      this.toast.show(
        this.translate.instant('sidebar.session_in_other_pane'),
        { kind: 'warning' },
      );
      this.state.requestPaneFocus('primary');
      return;
    }
    this.state.requestSessionAdopt(session.id);
  }

  /** S-2 F5.4: in split mode, the focused pane's session item carries the same
   *  accent border as the focused pane itself — single-pane mode keeps the
   *  plain active marker (the pane shows no border there either). */
  sessionAccent(session: SessionMeta): boolean {
    return this.state.splitActive() && this.state.isSessionFocused(session);
  }

  /** S-2 F1.2: compact agent badge for a listed session (null without identity). */
  agentBadge(session: SessionMeta): string | null {
    return session.agentId ? agentLabel(session.agentId as SkillAgent) : null;
  }

  /** S-2 F1.2: continuing this session with the CURRENT agent implies a handoff. */
  agentMismatch(session: SessionMeta): boolean {
    return !!session.agentId && session.agentId !== this.state.config()?.agentId;
  }

  /** S-2 F0.3: true when clicking this listed session would be rejected by the
   *  busy-destination guard. Focused/mounted items stay interactive (focus). */
  isSessionBlocked(session: SessionMeta): boolean {
    if (this.state.isSessionFocused(session) || this.state.isSessionMounted(session.id)) return false;
    return !this.state.canSwitchSession(session.id).ok;
  }

  /** S-2 F0.3: a session whose agent is mid-run must not be deleted. Covers the
   *  primary's active session and sessions mounted as running split panes. */
  private isSessionDeleteBlocked(projectPath: string, session: SessionMeta): boolean {
    if (this.state.isRunning(session.id)) return true;
    return session.isActive && this.state.isRunning(projectPath);
  }

  async deleteSession(projectPath: string, session: SessionMeta): Promise<void> {
    if (this.isSessionDeleteBlocked(projectPath, session)) {
      this.toast.show(
        this.translate.instant('sidebar.session_delete_blocked_running'),
        { kind: 'warning' },
      );
      return;
    }
    const hint = this.translate.instant(
      session.isActive ? 'sidebar.delete_session_hint_active' : 'sidebar.delete_session_hint_inactive',
    );
    const ok = await firstValueFrom(
      this.dialogs.confirm({
        title: this.translate.instant('sidebar.delete_session_title'),
        message: `${this.translate.instant('sidebar.delete_session_message')} ${hint}`,
        confirmLabel: this.translate.instant('sidebar.delete_session_confirm'),
        cancelLabel: this.translate.instant('sidebar.delete_session_cancel'),
        danger: true,
      }),
    );
    if (!ok) return;
    await this.state.deleteSession(projectPath, session.id);
  }

  onDoubleClick(p: ProjectEntry): void {
    // Folders navigate, not pin — single-click already covers that.
    if (p.tech === 'folder') return;
    void this.state.pin(p);
    this.state.selectProject(p.path);
  }

  pinProject(p: ProjectEntry): void {
    void this.state.pin(p);
  }

  selectPath(path: string): void {
    this.state.selectProject(path);
  }

  unpinPath(path: string): void {
    void this.state.unpin(path);
  }

  onContextMenuPath(event: MouseEvent, path: string): void {
    // Reuse the project context menu by synthesising the minimum
    // ProjectEntry shape from cached state. Falls back to 'folder' tech
    // only if we somehow have no snapshot — the menu still works in that
    // case.
    event.preventDefault();
    event.stopPropagation();
    const tech = this.state.pinnedTech().get(path) ?? 'folder';
    const isRunning = this.state.isRunning(path);
    const name = leafOfPath(path);
    this.ctxX.set(event.clientX);
    this.ctxY.set(event.clientY);
    this.ctxProject.set({ name, path, isRunning, tech });
    setTimeout(() => this.ctxMenuRef().open(), 0);
  }

  // ── Per-project shell actions ─────────────────────────────────────────

  private absolutePath(p: ProjectEntry): string {
    const root = this.state.config()?.workspaceRoot ?? '';
    return root ? `${root}/${p.path}` : p.path;
  }

  openInExplorer(p: ProjectEntry): void {
    this.api.openPath(this.absolutePath(p));
  }

  openInIde(p: ProjectEntry): void {
    this.api.openInIde(this.absolutePath(p));
  }

  async copyPath(p: ProjectEntry): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.absolutePath(p));
    } catch (err) {
      console.error('[clipboard]', err);
    }
  }

  stopProcess(p: ProjectEntry): void {
    this.api.stopProject(p.path);
  }

  async resetSession(p: ProjectEntry): Promise<void> {
    await this.api.resetSession(p.path);
    // Clear the renderer-owned visible thread too — otherwise the next
    // instruction keeps appending to the old session (single-pane key === path).
    await this.state.resetSessionLocal(p.path, p.path);
  }

  async trash(p: ProjectEntry): Promise<void> {
    const label = this.translate.instant(
      p.tech === 'folder' ? 'sidebar.trash_label_folder' : 'sidebar.trash_label_project',
      { name: p.name },
    );
    const ok = await firstValueFrom(
      this.dialogs.confirm({
        title: this.translate.instant('sidebar.trash_title'),
        message: this.translate.instant('sidebar.trash_message', { label }),
        confirmLabel: this.translate.instant('sidebar.trash_confirm_text'),
        cancelLabel: this.translate.instant('sidebar.trash_cancel_text'),
        danger: true,
      }),
    );
    if (!ok) return;
    try {
      await this.api.trashProject(p.path);
      const sel = this.state.selectedProject();
      if (sel === p.path || (sel?.startsWith(p.path + '/') ?? false)) {
        this.state.selectedProject.set(null);
      }
      const last = this.state.config()?.lastProjectPath;
      if (last === p.path || (last?.startsWith(p.path + '/') ?? false)) {
        void this.api.setConfig({ lastProjectPath: '' });
      }
      // E-DSK-12: forget the in-memory SDD state (bootstrap guard +
      // notifications) so recreating the project at the same path is a
      // fresh first contact. Persistent cache is purged main-side.
      this.kanban.forgetProject(p.path);
      await this.state.reloadProjects();
      this.state.pinnedPaths.set(this.state.pinnedPaths().filter((x) => x !== p.path));
    } catch (err) {
      console.error('[trash]', err);
      this.toast.show(
        this.translate.instant('sidebar.trash_error', { error: (err as Error).message }),
        { kind: 'error', durationMs: 8000 },
      );
    }
  }

  createFolder(): void {
    this.dialog.open(NewFolderModalComponent, {
      maxWidth: 'calc(100vw - 2rem)',
      panelClass: 'dv-dialog-panel',
      backdropClass: 'dv-dialog-backdrop',
      autoFocus: true,
      restoreFocus: true,
    });
  }

  renameFolder(p: ProjectEntry): void {
    const data: RenameFolderModalData = { path: p.path, currentName: p.name };
    this.dialog.open(RenameFolderModalComponent, {
      data,
      maxWidth: 'calc(100vw - 2rem)',
      panelClass: 'dv-dialog-panel',
      backdropClass: 'dv-dialog-backdrop',
      autoFocus: true,
      restoreFocus: true,
    });
  }

  // ── Splitter drag — measures DOM, delegates math to layout service. ──

  startPinnedSplitterDrag(event: MouseEvent): void {
    const pinned = this.pinnedSection()?.nativeElement;
    const projects = this.projectsSection()?.nativeElement;
    if (!pinned || !projects) return;
    const a = pinned.getBoundingClientRect().height;
    const b = projects.getBoundingClientRect().height;
    this.layout.startPinnedDrag(event, {
      anchorHeightPx: a,
      combinedHeightPx: a + b,
    });
  }

  startSessionsSplitterDrag(event: MouseEvent): void {
    const sessions = this.sessionsSection()?.nativeElement;
    const projects = this.projectsSection()?.nativeElement;
    if (!sessions || !projects) return;
    const a = sessions.getBoundingClientRect().height;
    const b = projects.getBoundingClientRect().height;
    this.layout.startSessionsDrag(event, {
      anchorHeightPx: a,
      combinedHeightPx: a + b,
    });
  }
}
