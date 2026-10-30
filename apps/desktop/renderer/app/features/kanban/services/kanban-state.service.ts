import { Injectable, computed, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

import { AppStateService } from '../../../core/services/app-state.service';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { ToastService } from '../../../core/services/toast.service';
import type {
  BootstrapView,
  KanbanAgentWakeEvent,
  KanbanBoardView,
  ProjectClassification,
  SddNotification,
} from '../../../../types/devia';

const MAX_NOTIFICATIONS = 200;

/**
 * Renderer-side state for the devia-native SDD feature (E-DSK-12).
 *
 * Holds the active project's kanban board and the global notification
 * list, and is the single subscriber to the three SDD streams:
 *   - onKanbanChanged → refresh the board signal (any source: UI,
 *     agent or out-of-process MCP server).
 *   - onAgentWake     → auto-dispatch the carried instruction for
 *     `started` / `user_reply` (T6); just notify for
 *     `dependency_resolved`.
 *   - onNotification  → prepend + toast action-needed items (T7).
 *
 * Instantiated at startup (injected by AppComponent) so notifications
 * arrive even when the board modal is closed.
 */
@Injectable({ providedIn: 'root' })
export class KanbanStateService {
  private readonly api = inject(ElectronApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly appState = inject(AppStateService);

  readonly board = signal<KanbanBoardView | null>(null);
  readonly notifications = signal<SddNotification[]>([]);
  readonly unreadCount = computed(() => this.notifications().filter((n) => !n.read).length);

  private currentProject: string | null = null;
  /** Projects whose bootstrap modal was already offered this session —
   *  prevents re-prompting on every project switch after a "Más tarde". */
  private readonly promptedThisSession = new Set<string>();
  /** Projects where SDD planning was kicked off this session but the board
   *  has no tasks yet — gates the kanban icon (toast instead of an empty
   *  board) while the agent is still planning. A signal so the board's
   *  "planificación en curso" empty-state reacts when planning starts/ends. */
  private readonly planningProjects = signal<ReadonlySet<string>>(new Set());

  constructor() {
    this.api.onKanbanChanged((e) => {
      if (e.projectPath === this.currentProject) this.board.set(e.board);
      // Planning is done once the board has real tasks — stop gating the icon.
      if (e.board.tasks.length > 0) this.unmarkPlanning(e.projectPath);
    });
    this.api.onAgentWake((e) => this.handleWake(e));
    this.api.onSddNotification((e) => {
      const n = e.notification;
      this.notifications.update((list) => [n, ...list].slice(0, MAX_NOTIFICATIONS));
      const title = this.translate.instant(this.notifTitleKey(n));
      const body = this.notifBody(n);
      if (n.kind === 'user_input') {
        this.toast.show(body ? `${title} · ${body}` : title, { kind: 'info', durationMs: 9000 });
      }
      // Native OS notification: action-needed always; informational only
      // when the window isn't focused. Text is localised here (the main
      // process owns no i18n strings).
      if (n.kind === 'user_input' || !document.hasFocus()) {
        void this.api.sddNotifyOs(title, body);
      }
    });
    void this.refreshNotifications();
  }

  /** i18n key for a notification's title, derived from its kind. */
  notifTitleKey(n: SddNotification): string {
    return `sdd.notif.${n.kind}`;
  }

  /** Language-neutral detail line: "T-3 · Título". */
  notifBody(n: SddNotification): string {
    if (n.taskId && n.taskTitle) return `${n.taskId} · ${n.taskTitle}`;
    return n.taskTitle ?? n.taskId ?? '';
  }

  /** Called by AppStateService when the active project changes. */
  async onProjectSelected(project: string | null): Promise<void> {
    this.currentProject = project;
    this.board.set(null);
    if (!project) return;
    await Promise.all([this.loadBoard(project), this.refreshNotifications(project)]);
  }

  async loadBoard(project: string): Promise<void> {
    const board = await this.api.kanbanBoard(project);
    if (this.currentProject === project) this.board.set(board);
  }

  async refreshNotifications(project?: string): Promise<void> {
    this.notifications.set(await this.api.sddNotifications(project));
  }

  async markNotificationsRead(project?: string): Promise<void> {
    await this.api.sddMarkNotificationsRead(project);
    this.notifications.update((list) => list.map((n) => ({ ...n, read: true })));
  }

  async clearNotifications(project?: string): Promise<void> {
    await this.api.sddClearNotifications(project);
    this.notifications.set([]);
  }

  /**
   * First-contact check (T2). Returns the classification so the caller
   * can open the bootstrap modal — or null when the project was
   * already bootstrapped / the workspace is unset.
   */
  async checkBootstrap(project: string): Promise<BootstrapView | null> {
    if (this.promptedThisSession.has(project)) return null;
    const result = await this.api.sddBootstrap(project);
    if (result.alreadyBootstrapped) return null;
    this.promptedThisSession.add(project);
    return result;
  }

  /**
   * Forget a trashed project (and its descendants): drops the
   * session-scoped "already prompted" guard so recreating it at the same
   * path is treated as first contact again, clears the board if active,
   * and removes its notifications. The persistent cache is purged by the
   * main process during the trash itself.
   */
  forgetProject(project: string): void {
    const prefix = `${project}/`;
    for (const p of [...this.promptedThisSession]) {
      if (p === project || p.startsWith(prefix)) this.promptedThisSession.delete(p);
    }
    for (const p of this.planningProjects()) {
      if (p === project || p.startsWith(prefix)) this.unmarkPlanning(p);
    }
    if (this.currentProject === project) {
      this.currentProject = null;
      this.board.set(null);
    }
    this.notifications.update((list) =>
      list.filter((n) => n.projectPath !== project && !n.projectPath.startsWith(prefix)),
    );
    void this.api.sddClearNotifications(project);
  }

  /** True while SDD planning is in flight for a project (started this
   *  session, board not yet populated). Signal-backed — safe in computeds. */
  isPlanning(project: string): boolean {
    return this.planningProjects().has(project);
  }

  private markPlanning(project: string): void {
    this.planningProjects.update((s) => new Set(s).add(project));
  }

  private unmarkPlanning(project: string): void {
    this.planningProjects.update((s) => {
      if (!s.has(project)) return s;
      const next = new Set(s);
      next.delete(project);
      return next;
    });
  }

  /**
   * Kick off the SDD planning flow (SDD-F2): turn the bootstrap decision into
   * a PLAN-mode agent run. Adds a user-visible chat message with the captured
   * intent (so the conversation isn't empty), switches the composer to Plan
   * mode, marks the project as "planning" (gates the kanban icon), then
   * dispatches the planner prompt through the normal chat path.
   *
   * `intent` seeds the prompt (and the spec, for new projects). `displayText`
   * overrides what the user sees in the chat bubble; defaults to `intent`.
   */
  async startSddPlanning(
    project: string,
    classification: ProjectClassification,
    intent: string,
    displayText?: string,
  ): Promise<void> {
    const result =
      classification === 'new'
        ? await this.api.sddInit(project, intent)
        : await this.api.sddPrepare(project);
    if (!result.prompt) return;
    const prompt =
      classification === 'existing' && intent
        ? `${result.prompt}\n\nContexto del usuario: ${intent}`
        : result.prompt;
    const shown =
      (displayText ?? intent).trim() || this.translate.instant('sdd.start_default_message');
    this.appState.setRunMode(project, result.mode);
    this.markPlanning(project);
    // `shown` rides as displayText: if the call lands in the queue, the later
    // queue:dispatched event adds the bubble with it (never the raw planner
    // prompt). Inline → add the bubble now, same deferral the chat panel uses,
    // so a queued planner doesn't show the message twice.
    const sendResult = await this.api.sendInstruction(project, prompt, [], result.mode, shown);
    if (!sendResult?.queued) {
      this.appState.addMessage(project, { id: '', role: 'user', text: shown });
    }
  }

  private handleWake(e: KanbanAgentWakeEvent): void {
    if (e.reason === 'dependency_resolved') {
      this.toast.show(
        this.translate.instant('sdd.wake_dependency', { task: e.taskTitle }),
        { kind: 'info', durationMs: 6000 },
      );
      return;
    }
    // started / user_reply: drive the agent through the normal chat path. The
    // displayText keeps the raw wake prompt out of the chat if it gets queued.
    const shown = this.translate.instant('sdd.wake_dispatch', {
      task: `${e.taskId} · ${e.taskTitle}`,
    });
    void this.api.sendInstruction(e.projectPath, e.prompt, [], 'apply', shown);
  }
}
