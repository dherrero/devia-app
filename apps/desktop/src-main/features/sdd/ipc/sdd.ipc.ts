import * as path from 'node:path';
import { Notification, app } from 'electron';

import type { FeatureContext } from '../../../shared/feature';
import type { ConfigRepository } from '../../../shared/ports';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import { resolveInsideWorkspace } from '../../../shared/workspace-paths';
import type {
  BlockReason,
  KanbanBoardView,
  KanbanColumn,
} from '../../../../shared/domain/kanban';
import { isBlockReason, isKanbanColumn } from '../../../../shared/domain/kanban';

import { KanbanStore } from '../kanban/infrastructure/kanban-store';
import { KanbanUseCase } from '../kanban/application/kanban.use-case';
import { BootstrapDetector } from '../bootstrap/bootstrap';
import { PrepareUseCase } from '../prepare/prepare.use-case';
import { buildWakePrompt } from '../prepare/prompts';
import { NotificationStore } from '../notifications/notification-store';
import { diffForNotifications } from '../notifications/board-reconciler';
import { KanbanWatcher } from '../watch/kanban-watcher';
import { scanCommitLinks } from '../commit/commit-footer';

/**
 * IPC adapter for the devia-native SDD feature (E-DSK-12).
 *
 * Wires every kanban / bootstrap / prepare / notification channel and
 * is the single place where the use-case hooks become renderer events:
 *   - onChange       → kanban:changed + notification reconciliation
 *   - onAgentWake     → kanban:agent-wake (renderer dispatches it)
 *
 * The renderer always speaks workspace-RELATIVE project paths; we
 * resolve to absolute for filesystem work and echo the relative path
 * back in events so the renderer's `e.projectPath === selectedProject()`
 * filter matches (same convention as sub-agents / MCP).
 */
const COMMIT_SCAN_THROTTLE_MS = 5_000;

export interface SddIpcDeps {
  config: ConfigRepository;
  store: KanbanStore;
  detector: BootstrapDetector;
  notifications: NotificationStore;
  /** Created here so onBeforeQuit can tear it down. */
  watcherRef: { current: KanbanWatcher | null };
}

export function registerSddIpc(ctx: FeatureContext, deps: SddIpcDeps): void {
  const { config, store, detector, notifications } = deps;

  const absToRel = new Map<string, string>();
  const lastBoard = new Map<string, KanbanBoardView>();
  const lastScan = new Map<string, number>();

  const toAbs = (rel: string): string | null => {
    try {
      const { abs } = resolveInsideWorkspace(config, rel);
      absToRel.set(abs, rel);
      return abs;
    } catch {
      return null;
    }
  };
  const relFor = (abs: string): string => absToRel.get(abs) ?? abs;

  const emitChanged = (abs: string): void => {
    const rel = relFor(abs);
    const board = store.boardView(abs);
    ctx.send('kanban:changed', { projectPath: rel, board: { ...board, projectPath: rel } });

    const intents = diffForNotifications(rel, lastBoard.get(abs) ?? null, board);
    lastBoard.set(abs, board);
    for (const intent of intents) {
      const n = notifications.add(intent);
      if (!n) continue;
      // Token-only payload; the renderer localises it and decides whether
      // to raise the OS notification (it owns the i18n strings).
      ctx.send('sdd:notification', {
        projectPath: rel,
        notification: n,
        unreadTotal: notifications.unreadTotal(),
      });
    }
  };

  const useCase = new KanbanUseCase(store, {
    onChange: (abs) => emitChanged(abs),
    onAgentWake: (abs, task, reason) => {
      ctx.send('kanban:agent-wake', {
        projectPath: relFor(abs),
        taskId: task.id,
        taskTitle: task.title,
        reason,
        prompt: buildWakePrompt(task, reason, uiLanguage()),
      });
    },
  });

  const prepare = new PrepareUseCase(useCase);
  const watcher = new KanbanWatcher(store, (abs) => emitChanged(abs));
  deps.watcherRef.current = watcher;

  const projectName = (abs: string): string => path.basename(abs);

  /** UI language for the reply-language line in SDD prompts: the user's
   *  Settings pick when persisted, otherwise the OS locale (same fallback
   *  the renderer uses when `config.language` is unset). */
  const uiLanguage = (): string => {
    const persisted = config.get().language;
    if (persisted) return persisted;
    try {
      return app.getLocale() || 'en';
    } catch {
      return 'en';
    }
  };

  /** Start the file watcher and seed the notification baseline. Idempotent.
   *  (The kanban MCP server reaches the agent with every RUN, through the
   *  agent's mapper — S-30 — so opening the board writes no agent config.) */
  const ensureWired = (abs: string): void => {
    watcher.watch(abs);
    if (!lastBoard.has(abs)) lastBoard.set(abs, store.boardView(abs));
  };

  const maybeScanCommits = (abs: string): void => {
    const now = Date.now();
    if (now - (lastScan.get(abs) ?? 0) < COMMIT_SCAN_THROTTLE_MS) return;
    lastScan.set(abs, now);
    try {
      const links = scanCommitLinks(abs);
      if (links.size > 0) useCase.syncCommitLinks(abs, links);
    } catch {
      // best-effort
    }
  };

  // ── bootstrap (T2) / prepare (T3) / init (T9) ─────────────────────

  ctx.ipc.handle(IPC.sddBootstrap, (_e, rel: string, force?: boolean) => {
    const abs = toAbs(rel);
    if (!abs) {
      return {
        classification: 'existing' as const,
        gitInitialised: false,
        alreadyBootstrapped: true,
      };
    }
    return detector.detect(abs, force ? { force: true } : {});
  });

  ctx.ipc.handle(IPC.sddPrepare, (_e, rel: string) => {
    const abs = toAbs(rel);
    if (!abs) return { prompt: '', mode: 'apply' as const };
    ensureWired(abs);
    detector.markEngaged(abs);
    return prepare.prepare(projectName(abs), uiLanguage());
  });

  ctx.ipc.handle(IPC.sddCreateSpec, (_e, rel: string, intent: string, title?: string) => {
    const abs = toAbs(rel);
    if (!abs) return { prompt: '', mode: 'apply' as const };
    ensureWired(abs);
    detector.markEngaged(abs);
    const result = prepare.init(abs, projectName(abs), intent, title, uiLanguage());
    emitChanged(abs); // the seed spec just landed
    return result;
  });

  // Record a project at "+"-creation time WITHOUT seeding the board —
  // used by the unified "Nuevo proyecto" modal's "Crear" action. Stores
  // the `newProject` flag (blank/base → new, import → existing) so a
  // later "Preparar proyecto" routes init vs prepare correctly.
  ctx.ipc.handle(IPC.sddMarkHandled, (_e, rel: string, classification: string) => {
    const abs = toAbs(rel);
    if (!abs) return false;
    detector.markCreated(abs, classification !== 'existing');
    return true;
  });

  // Flip `newProject` to false when a conversation has started in the
  // project (the renderer detects existing chat history on selection).
  ctx.ipc.handle(IPC.sddMarkEngaged, (_e, rel: string) => {
    const abs = toAbs(rel);
    if (!abs) return false;
    detector.markEngaged(abs);
    return true;
  });

  // ── board read ────────────────────────────────────────────────────

  ctx.ipc.handle(IPC.kanbanBoard, (_e, rel: string): KanbanBoardView => {
    const abs = toAbs(rel);
    if (!abs) return { projectPath: rel, specs: [], tasks: [] };
    ensureWired(abs);
    maybeScanCommits(abs);
    const board = store.boardView(abs);
    return { ...board, projectPath: rel };
  });

  ctx.ipc.handle(IPC.kanbanTask, (_e, rel: string, taskId: string) => {
    const abs = toAbs(rel);
    return abs ? store.taskView(abs, taskId) : null;
  });

  // ── board mutations (UI). onChange hook emits kanban:changed. ──────

  ctx.ipc.handle(
    IPC.kanbanCreateTask,
    (_e, rel: string, specId: string, title: string, body?: string, dependsOn?: string[]): string | null => {
      const abs = toAbs(rel);
      if (!abs) return null;
      return useCase.createTask(abs, specId, title, body ?? '', dependsOn ?? []).id;
    },
  );

  ctx.ipc.handle(
    IPC.kanbanUpdateTask,
    (_e, rel: string, taskId: string, fields: Record<string, unknown>): boolean => {
      const abs = toAbs(rel);
      if (!abs) return false;
      return useCase.updateTask(abs, taskId, sanitizeFields(fields)) !== null;
    },
  );

  ctx.ipc.handle(IPC.kanbanMoveTask, (_e, rel: string, taskId: string, column: string) => {
    const abs = toAbs(rel);
    if (!abs || !isKanbanColumn(column)) return false;
    return useCase.moveTask(abs, taskId, column as KanbanColumn, { viaUser: true }) !== null;
  });

  ctx.ipc.handle(IPC.kanbanCloseTask, (_e, rel: string, taskId: string, commit?: string) => {
    const abs = toAbs(rel);
    if (!abs) return false;
    return useCase.closeTask(abs, taskId, commit) !== null;
  });

  ctx.ipc.handle(IPC.kanbanDeleteTask, (_e, rel: string, taskId: string) => {
    const abs = toAbs(rel);
    if (!abs) return false;
    return useCase.deleteTask(abs, taskId);
  });

  ctx.ipc.handle(IPC.kanbanArchiveSpec, (_e, rel: string, specId: string, force?: boolean) => {
    const abs = toAbs(rel);
    if (!abs) return false;
    return useCase.archiveSpec(abs, specId, { force: force === true }).ok;
  });

  ctx.ipc.handle(
    IPC.kanbanBlockTask,
    (_e, rel: string, taskId: string, reason: string, target?: string) => {
      const abs = toAbs(rel);
      if (!abs || !isBlockReason(reason)) return false;
      return useCase.blockTask(abs, taskId, reason as BlockReason, target) !== null;
    },
  );

  ctx.ipc.handle(IPC.kanbanUnblockTask, (_e, rel: string, taskId: string, resolution?: string) => {
    const abs = toAbs(rel);
    if (!abs) return false;
    return useCase.unblockTask(abs, taskId, resolution) !== null;
  });

  ctx.ipc.handle(IPC.kanbanComment, (_e, rel: string, taskId: string, body: string): boolean => {
    const abs = toAbs(rel);
    if (!abs) return false;
    return useCase.comment(abs, taskId, 'user', body) !== null;
  });

  ctx.ipc.handle(IPC.kanbanMarkRead, (_e, rel: string, taskId: string) => {
    const abs = toAbs(rel);
    if (abs) useCase.markThreadRead(abs, taskId);
  });

  // ── notification centre (T7) ───────────────────────────────────────

  ctx.ipc.handle(IPC.sddNotificationsGet, (_e, rel?: string) =>
    notifications.list(rel),
  );
  ctx.ipc.handle(IPC.sddNotificationsMarkRead, (_e, rel?: string) => {
    notifications.markRead(rel);
  });
  ctx.ipc.handle(IPC.sddNotificationsClear, (_e, rel?: string) => {
    notifications.clear(rel);
  });

  // Fire a native OS notification with text the renderer already
  // localised (the main process owns no i18n strings). The renderer
  // decides when to call this (action-needed, or window unfocused).
  ctx.ipc.handle(IPC.sddNotifyOs, (_e, title: string, body: string) => {
    try {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    } catch {
      // best-effort
    }
  });
}

/** Narrow the renderer-supplied update payload to the editable fields. */
function sanitizeFields(
  fields: Record<string, unknown>,
): { title?: string; body?: string; dueDate?: string; dependsOn?: string[]; sortIndex?: number; specId?: string } {
  const out: { title?: string; body?: string; dueDate?: string; dependsOn?: string[]; sortIndex?: number; specId?: string } = {};
  if (typeof fields['title'] === 'string') out.title = fields['title'];
  if (typeof fields['body'] === 'string') out.body = fields['body'];
  if (typeof fields['dueDate'] === 'string') out.dueDate = fields['dueDate'];
  if (typeof fields['specId'] === 'string') out.specId = fields['specId'];
  if (Array.isArray(fields['dependsOn'])) {
    out.dependsOn = (fields['dependsOn'] as unknown[]).filter((d): d is string => typeof d === 'string');
  }
  if (typeof fields['sortIndex'] === 'number') out.sortIndex = fields['sortIndex'];
  return out;
}
