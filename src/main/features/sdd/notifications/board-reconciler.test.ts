import { describe, expect, it } from 'vitest';

import type { KanbanBoardView, KanbanCardView } from '../../../../shared/domain/kanban';
import { diffForNotifications } from './board-reconciler';

function card(over: Partial<KanbanCardView> & { id: string }): KanbanCardView {
  return {
    specId: 'S-1',
    title: `Task ${over.id}`,
    column: 'todo',
    dependsOn: [],
    sortIndex: 0,
    unreadCount: 0,
    subagentNames: [],
    hasCommit: false,
    ...over,
  };
}

function board(tasks: KanbanCardView[]): KanbanBoardView {
  return { projectPath: 'p', specs: [], tasks };
}

describe('diffForNotifications (T7)', () => {
  it('raises user_input when a task enters blocked(user)', () => {
    const prev = board([card({ id: 'T-1', column: 'in_progress' })]);
    const next = board([card({ id: 'T-1', column: 'blocked', blockReason: 'user' })]);
    const out = diffForNotifications('p', prev, next);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('user_input');
    expect(out[0]?.taskId).toBe('T-1');
  });

  it('raises task_done when a task reaches done', () => {
    const prev = board([card({ id: 'T-1', column: 'in_progress' })]);
    const next = board([card({ id: 'T-1', column: 'done' })]);
    const out = diffForNotifications('p', prev, next);
    expect(out[0]?.kind).toBe('task_done');
  });

  it('raises task_blocked for dependency / subagent blocks', () => {
    const prev = board([card({ id: 'T-1', column: 'in_progress' })]);
    const next = board([card({ id: 'T-1', column: 'blocked', blockReason: 'subagent' })]);
    const out = diffForNotifications('p', prev, next);
    expect(out[0]?.kind).toBe('task_blocked');
  });

  it('does not re-raise when the state is unchanged', () => {
    const same = board([card({ id: 'T-1', column: 'blocked', blockReason: 'user' })]);
    expect(diffForNotifications('p', same, same)).toHaveLength(0);
  });

  it('treats a brand-new board (no prev) without spurious notifications for steady states', () => {
    const next = board([card({ id: 'T-1', column: 'todo' })]);
    expect(diffForNotifications('p', null, next)).toHaveLength(0);
  });
});
