import type { KanbanBoardView, KanbanCardView } from '../../../../shared/domain/kanban';
import type { NewNotification } from './notification-store';

/**
 * Derives notifications (E-DSK-12 T7) from observed board transitions
 * rather than from the mutation call site. This is what lets the
 * out-of-process MCP server (T5) raise user-facing notifications: the
 * app watches `kanban.json`, reconciles the new board against the
 * previous one, and emits notification intents for the transitions
 * that matter.
 *
 * Tracked transitions (per task, keyed by id):
 *   → blocked(user)               → 'user_input'  (action needed)
 *   → done                        → 'task_done'
 *   → blocked(dependency|subagent)→ 'task_blocked' (informational)
 *
 * Pure: returns intents; the caller persists + emits them.
 */
export function diffForNotifications(
  projectPath: string,
  prev: KanbanBoardView | null,
  next: KanbanBoardView,
): NewNotification[] {
  const before = new Map<string, KanbanCardView>(
    (prev?.tasks ?? []).map((t) => [t.id, t]),
  );
  const out: NewNotification[] = [];

  for (const task of next.tasks) {
    const old = before.get(task.id);
    const wasUserBlocked = old?.column === 'blocked' && old.blockReason === 'user';
    const isUserBlocked = task.column === 'blocked' && task.blockReason === 'user';
    const wasDone = old?.column === 'done';
    const isDone = task.column === 'done';
    const wasOtherBlocked =
      old?.column === 'blocked' && (old.blockReason === 'dependency' || old.blockReason === 'subagent');
    const isOtherBlocked =
      task.column === 'blocked' && (task.blockReason === 'dependency' || task.blockReason === 'subagent');

    // Data-only intents: the renderer localises title/body from `kind` +
    // the task fields. No Spanish text in the main process.
    if (isUserBlocked && !wasUserBlocked) {
      out.push({ projectPath, kind: 'user_input', taskId: task.id, taskTitle: task.title });
    } else if (isDone && !wasDone) {
      out.push({ projectPath, kind: 'task_done', taskId: task.id, taskTitle: task.title });
    } else if (isOtherBlocked && !wasOtherBlocked) {
      out.push({ projectPath, kind: 'task_blocked', taskId: task.id, taskTitle: task.title });
    }
  }

  return out;
}
