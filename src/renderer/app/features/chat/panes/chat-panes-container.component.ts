import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ButtonComponent, IconComponent, TooltipDirective } from '@devia/ui';
import { LucideColumns2, LucideRows2, LucideX } from '@lucide/angular';
import type { ChatMessage } from '../../../../../shared/domain/chat';
import type { SessionStats } from '../../../../../shared/domain/session-stats';
import { AppStateService } from '../../../core/services/app-state.service';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { ChatPanelComponent } from '../chat-panel/chat-panel.component';
import { ComposerDraftStore } from '../composer/composer-draft.store';
import { primarySessionRef } from '../../../../../shared/domain/session-ref';
import { PanesLayoutStore } from './panes-layout.store';
import {
  type Pane,
  type PanesLayout,
  singlePaneLayout,
  splitVertical,
  splitHorizontal,
  closePane,
  focusPane,
  splitIconFor,
} from './panes-layout.model';

/**
 * Split-view orchestrator (S-13 T-143). Holds the `PanesLayout`, mounts one
 * `ChatPanelComponent` per pane (each with its own session identity), renders
 * the split affordances + the close flow, and tracks the focused pane.
 *
 * The PRIMARY pane (the first one) runs on the real checkout (no runKey →
 * single-pane behaviour). Every ADDITIONAL pane gets a fresh session id and
 * runs isolated in its own git worktree (runKey = its session id). Closing an
 * additional pane kills its process and removes its worktree; the primary pane
 * is the anchor and cannot be closed (closing all additional panes returns to
 * the single-pane view).
 */
@Component({
  selector: 'ds-chat-panes-container',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslateModule, ButtonComponent, IconComponent, TooltipDirective, ChatPanelComponent],
  templateUrl: './chat-panes-container.component.html',
  styleUrl: './chat-panes-container.component.scss',
})
export class ChatPanesContainerComponent {
  private readonly state = inject(AppStateService);
  private readonly api = inject(ElectronApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  // Root-scoped: survives this component being destroyed when the user leaves
  // the chat route (Kanban, etc.) and comes back, so the split is restored on
  // any in-app navigation. See PanesLayoutStore.
  private readonly store = inject(PanesLayoutStore);
  private readonly drafts = inject(ComposerDraftStore);

  readonly LucideColumns2 = LucideColumns2;
  readonly LucideRows2 = LucideRows2;
  readonly LucideX = LucideX;

  readonly layout = signal<PanesLayout>(this.restoreFor(this.state.selectedProject()));

  // A pane awaiting close confirmation (process running) — drives the modal.
  readonly pendingClose = signal<Pane | null>(null);

  readonly columns = computed(() => this.layout().columns);
  readonly focusedPaneId = computed(() => this.layout().focusedPaneId);

  // S-3 F2.3: projects whose persisted skeleton was already attempted this app
  // run — restore is one-shot per project (the in-memory store takes over).
  private readonly diskRestoreAttempted = new Set<string>();

  constructor() {
    // Seed the shell with the (possibly restored) initial layout: which
    // sessions are mounted, whether a split is active, and which pane drives
    // the footer/git/navbar.
    this.publishShellState(this.layout());
    const initialFocused = this.layout().columns
      .flatMap((c) => c.panes)
      .find((p) => p.id === this.layout().focusedPaneId);
    if (initialFocused) this.state.setFocusedSession(this.runKeyFor(initialFocused));
    void this.restoreFromDisk(this.state.selectedProject());

    // Sidebar → focus an already-mounted pane when its session is clicked.
    // The 'primary' sentinel targets the primary pane (its runKey is null).
    effect(() => {
      const req = this.state.paneFocusRequest();
      if (req === null) return;
      const pane = this.layout().columns
        .flatMap((c) => c.panes)
        .find((p) => this.runKeyFor(p) === req || (req === 'primary' && p.id === 'primary'));
      this.state.clearPaneFocusRequest();
      if (pane) this.onFocus(pane.id);
    });

    // Sidebar → adopt a persisted session into the focused ADDITIONAL pane
    // (S-2 F5.2). The sidebar already filtered mounted/busy/primary cases.
    effect(() => {
      const sessionId = this.state.sessionAdoptRequest();
      if (sessionId === null) return;
      this.state.clearSessionAdoptRequest();
      void this.adoptIntoFocusedPane(sessionId);
    });

    let lastProject = this.state.selectedProject();
    effect(() => {
      const project = this.state.selectedProject();
      if (project === lastProject) return;
      lastProject = project;
      // Restore the target project's split from the root store (or start
      // fresh). Nothing is killed: background agents keep working and notify
      // on finish. Mutations persist to the store, so the leaving project's
      // split is already saved.
      const restored = this.restoreFor(project);
      this.layout.set(restored);
      this.publishShellState(restored);
      // Point the shell at the restored focused pane (git + footer + navbar).
      const focused = restored.columns.flatMap((c) => c.panes).find((p) => p.id === restored.focusedPaneId);
      if (focused) this.focusShellOn(focused);
      void this.restoreFromDisk(project);
    });
  }

  /**
   * S-3 F2.3: rebuild a persisted split after an app restart. The skeleton
   * stores only the arrangement + sessionIds; every additional pane is
   * re-resolved through the ADOPTION path so the worktree recovery chain
   * (F2.2) applies — a swept worktree degrades with the right warning instead
   * of mounting blind. Sessions that no longer exist are skipped; if only the
   * primary remains, the view stays single-pane. One-shot per project per app
   * run, and a no-op when the user already split (in-memory layout wins).
   */
  private async restoreFromDisk(project: string | null): Promise<void> {
    if (!project) return;
    const key = this.keyOf(project);
    if (this.diskRestoreAttempted.has(key)) return;
    this.diskRestoreAttempted.add(key);
    if (this.store.get(key) !== undefined) return; // live layout already exists
    const skeleton = this.store.readSkeleton(key);
    if (!skeleton) return;

    const columns: Array<{ panes: Pane[] }> = [];
    for (const col of skeleton.columns) {
      const panes: Pane[] = [];
      for (const slot of col.panes) {
        if (slot === null) {
          panes.push(this.makeSinglePane(project).columns[0]!.panes[0]!);
          continue;
        }
        try {
          const result = await this.api.adoptSession(project, slot, slot);
          if (result.isolation === 'recreated') {
            this.toast.show(this.translate.instant('panes.worktree_recreated_toast') as string, {
              kind: 'info',
              durationMs: 8000,
            });
          }
          this.state.loadSessionIntoKey(slot, result.messages as ChatMessage[], result.stats);
          panes.push({
            id: slot,
            sessionRef: {
              baseProject: project,
              sessionId: slot,
              workdir: result.workdir,
              branch: result.branch ?? '',
            },
          });
        } catch (err) {
          console.warn(`[panes] restore skipped session ${slot}:`, err);
        }
      }
      if (panes.length > 0) columns.push({ panes });
    }

    const flat = columns.flatMap((c) => c.panes);
    if (flat.length <= 1) {
      this.store.clearSkeleton(key);
      return;
    }
    // The user may have split or switched projects while adoptions resolved.
    if (this.state.selectedProject() !== project || this.layout().columns.flatMap((c) => c.panes).length > 1) {
      return;
    }
    const focused = flat.find((p) => p.id !== 'primary' && p.sessionRef.sessionId === skeleton.focusedSessionId)
      ?? flat[0]!;
    const next: PanesLayout = { columns, focusedPaneId: focused.id };
    this.commit(next);
    this.focusShellOn(focused);
  }

  private keyOf(project: string | null): string {
    return project ?? '';
  }

  /** Point the shell (right-rail git + footer/statusbar + sessions navbar) at a
   *  pane: its worktree drives git, its live-state key drives the footer and the
   *  active-session marker (T-155/T-157). The primary pane keys by `null` so the
   *  shell falls back to the selected project (single-pane unchanged). */
  private focusShellOn(pane: Pane): void {
    this.state.focusWorkdir(pane.sessionRef.workdir);
    this.state.setFocusedSession(this.runKeyFor(pane));
  }

  private restoreFor(project: string | null): PanesLayout {
    return this.store.get(this.keyOf(project)) ?? this.makeSinglePane(project);
  }

  /** Set the live layout AND persist it for the current project so it survives
   *  navigation away from the chat route. */
  private commit(next: PanesLayout): void {
    this.layout.set(next);
    this.store.set(this.keyOf(this.state.selectedProject()), next);
    this.publishShellState(next);
  }

  /** Mirror the layout into the shell: which additional-pane sessions are on
   *  screen (sessions navbar routing, T-157) and whether a split is active
   *  (right-rail hides the Terminal tab, T-158). */
  private publishShellState(layout: PanesLayout): void {
    const panes = layout.columns.flatMap((c) => c.panes);
    const keys = new Set(panes.filter((p) => p.id !== 'primary').map((p) => p.sessionRef.sessionId));
    this.state.setMountedPaneSessions(keys);
    this.state.setSplitActive(panes.length > 1);
  }

  private makeSinglePane(project: string | null): PanesLayout {
    // Stable id for the primary pane; its sessionRef carries no runKey so the
    // panel falls back to the global selection / active session (unchanged).
    const ref = primarySessionRef(project ?? '', '');
    const primary: Pane = { id: 'primary', sessionRef: ref };
    return singlePaneLayout(primary);
  }

  private async newAdditionalPane(): Promise<Pane> {
    const sessionId = crypto.randomUUID();
    const base = this.state.selectedProject() ?? '';
    let workdir = base;
    let branch = `devia/session-${sessionId.slice(0, 8)}`;
    // S-3 F1.1: isolation is MANDATORY for additional panes — always create
    // the worktree eagerly (no opt-in flag) so two panes of the same repo can
    // never write the same files. Failure (no git / no commits) degrades to
    // the base checkout but VISIBLY: the pane header shows a warning icon and
    // the first send asks for confirmation — never a silent fallback.
    try {
      const view = await this.api.addWorktree(base, sessionId);
      workdir = view.worktreeDir;
      branch = view.branch;
    } catch (err) {
      console.warn('[panes] worktree creation failed — pane runs UNISOLATED on the base checkout:', err);
    }
    // runKey === sessionId: opaque per-session identity the backend stamps on
    // events and uses to key its registry record + the worktree.
    return { id: sessionId, sessionRef: { baseProject: base, sessionId, workdir, branch } };
  }

  /** runKey for a pane: null for the primary anchor, the session id otherwise. */
  runKeyFor(pane: Pane): string | null {
    return pane.id === 'primary' ? null : pane.sessionRef.sessionId;
  }

  /** True when the pane runs in its own worktree (workdir differs from base). */
  isolatedFor(pane: Pane): boolean {
    return pane.id !== 'primary' && pane.sessionRef.workdir !== pane.sessionRef.baseProject;
  }

  splitIcon(columnIndex: number): 'vertical' | 'horizontal' | 'none' {
    return splitIconFor(this.layout(), columnIndex);
  }

  async onSplit(columnIndex: number): Promise<void> {
    const icon = this.splitIcon(columnIndex);
    if (icon === 'none') return;
    const pane = await this.newAdditionalPane();
    const next =
      icon === 'vertical'
        ? splitVertical(this.layout(), pane)
        : splitHorizontal(this.layout(), columnIndex, pane);
    this.commit(next);
    // The new pane is focused: point the shell at it (git + footer + navbar).
    this.focusShellOn(pane);
  }

  onFocus(paneId: string): void {
    const next = focusPane(this.layout(), paneId);
    this.commit(next);
    const pane = next.columns.flatMap((c) => c.panes).find((p) => p.id === paneId);
    if (pane) this.focusShellOn(pane);
  }

  /** Close button on a pane. Guards a running agent OR a dirty worktree
   *  (uncommitted changes) behind the "work will be lost" modal. */
  async onRequestClose(pane: Pane): Promise<void> {
    if (pane.id === 'primary') return; // anchor — never closed
    const key = this.runKeyFor(pane);
    if (key && this.state.isRunning(key)) {
      this.pendingClose.set(pane);
      return;
    }
    if (await this.isWorktreeDirty(pane)) {
      this.pendingClose.set(pane);
      return;
    }
    await this.closePane(pane);
  }

  /** True when the pane's worktree has uncommitted changes. Best-effort: a
   *  never-run pane (no worktree yet) or a non-isolated pane reads as clean. */
  private async isWorktreeDirty(pane: Pane): Promise<boolean> {
    if (!this.isolatedFor(pane)) return false;
    try {
      const info = await this.api.getGitInfo(pane.sessionRef.workdir);
      return (info?.changedCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /** Modal: confirm closing a pane whose agent is still running. */
  confirmClose(): void {
    const pane = this.pendingClose();
    this.pendingClose.set(null);
    if (pane) void this.closePane(pane);
  }

  cancelClose(): void {
    this.pendingClose.set(null);
  }

  /**
   * S-2 F5.2: load a persisted session into the focused additional pane and
   * RE-KEY the pane to it — runKey === sessionRef.sessionId is the invariant
   * `isSessionFocused`/`mountedPaneSessions` rely on, so the pane's identity
   * becomes the adopted session id. S-3 F2.2: the pane runs on the EFFECTIVE
   * workdir main resolved (live worktree → recreated → base checkout); the
   * previous pane's eagerly created worktree is removed best-effort when it
   * has no run.
   */
  private async adoptIntoFocusedPane(sessionId: string): Promise<void> {
    const layout = this.layout();
    const pane = layout.columns.flatMap((c) => c.panes).find((p) => p.id === layout.focusedPaneId);
    if (!pane || pane.id === 'primary') return; // primary is handled by switchSession
    const base = this.state.selectedProject() ?? pane.sessionRef.baseProject;

    let result: {
      id: string;
      messages: unknown[];
      stats?: SessionStats;
      workdir: string;
      branch?: string;
      isolation: 'worktree' | 'recreated' | 'none';
    };
    try {
      result = await this.api.adoptSession(base, sessionId, sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const key = message.includes('SESSION_QUEUE_PENDING')
        ? 'sidebar.session_switch_blocked_queue'
        : message.includes('SESSION_BUSY')
          ? 'sidebar.session_switch_blocked_running'
          : null;
      if (key) this.toast.show(this.translate.instant(key) as string, { kind: 'warning' });
      else console.error('[panes] adoptSession failed:', err);
      return;
    }

    const oldKey = this.runKeyFor(pane);
    if (oldKey && !this.state.isRunning(oldKey)) {
      // S-3: same zero-activity rule as closePane — an untouched pane (the
      // common case: fresh split that immediately adopts a session) must not
      // leave its eager worktree's branch behind.
      const untouched = (this.state.chats().get(oldKey)?.length ?? 0) === 0;
      // Flush before clearing for the same reason as closePane (S-2 F5.3).
      try {
        await this.state.flushSave(oldKey);
      } catch {
        /* best-effort */
      }
      try {
        if (untouched) {
          await this.api.cleanupWorktree(pane.sessionRef.baseProject, pane.sessionRef.sessionId);
        } else {
          await this.api.removeWorktree(pane.sessionRef.baseProject, pane.sessionRef.sessionId);
        }
      } catch {
        /* worktree may not exist (never ran) — ignore */
      }
      this.state.clearChat(oldKey);
    }
    // S-14: the pane re-keys to the adopted session, so the previous key's
    // composer never remounts — drop its draft (and preview URLs).
    if (oldKey) this.drafts.purge(oldKey);

    const branch = result.branch ?? this.state.gitInfo()?.branch ?? '';
    const adopted: Pane = {
      id: sessionId,
      sessionRef: { baseProject: base, sessionId, workdir: result.workdir, branch },
    };
    if (result.isolation === 'recreated') {
      this.toast.show(this.translate.instant('panes.worktree_recreated_toast') as string, {
        kind: 'info',
        durationMs: 8000,
      });
    }
    this.state.loadSessionIntoKey(sessionId, result.messages as ChatMessage[], result.stats);
    const next: PanesLayout = {
      ...layout,
      columns: layout.columns.map((c) => ({
        ...c,
        panes: c.panes.map((p) => (p.id === pane.id ? adopted : p)),
      })),
      focusedPaneId: adopted.id,
    };
    this.commit(next);
    this.focusShellOn(adopted);
  }

  private async closePane(pane: Pane): Promise<void> {
    const key = this.runKeyFor(pane);
    if (key) {
      // S-3: a pane closed with ZERO activity (no messages, nothing running)
      // leaves no trace — worktree AND session branch are torn down. Any
      // activity keeps the branch so the persisted session can be re-adopted
      // later (F2.2 recovery chain). Decided BEFORE stopping/flushing.
      const untouched =
        !this.state.isRunning(key) && (this.state.chats().get(key)?.length ?? 0) === 0;
      this.api.stopProject(key); // kill any running agent for this session
      // S-2 F5.3: flush any debounced save BEFORE clearing the live chat —
      // otherwise the pending timer fires after clearChat and persists an
      // EMPTY transcript over the session's last messages. The persistence
      // mapping is still registered at this point (the pane unmounts later).
      try {
        await this.state.flushSave(key);
      } catch {
        /* best-effort — never block the close */
      }
      // Best-effort worktree teardown; the startup sweep (T-154) is the safety net.
      try {
        if (untouched) {
          await this.api.cleanupWorktree(pane.sessionRef.baseProject, pane.sessionRef.sessionId);
        } else {
          await this.api.removeWorktree(pane.sessionRef.baseProject, pane.sessionRef.sessionId);
        }
      } catch {
        /* worktree may not exist yet (no run happened) — ignore */
      }
      this.state.clearChat(key);
      // S-14: no orphaned drafts — the entry dies with the pane (tombstoned
      // so the panel's late destroy-save cannot resurrect it).
      this.drafts.purge(key);
    }
    const next = closePane(this.layout(), pane.id);
    this.commit(next);
    // Re-point the shell at whatever pane now has focus.
    const focused = next.columns.flatMap((c) => c.panes).find((p) => p.id === next.focusedPaneId);
    if (focused) this.focusShellOn(focused);
  }
}
