import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { KanbanStore } from '../infrastructure/kanban-store';
import { KanbanUseCase, type AgentWakeReason } from './kanban.use-case';
import type { KanbanTask } from '../../../../../shared/domain/kanban';

function setup() {
  const deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-kanban-'));
  const store = new KanbanStore(() => deviaDir);
  const wakes: Array<{ task: KanbanTask; reason: AgentWakeReason }> = [];
  const userInputs: Array<{ task: KanbanTask; question: string }> = [];
  const uc = new KanbanUseCase(store, {
    onAgentWake: (_p, task, reason) => wakes.push({ task, reason }),
    onUserInputRequest: (_p, task, question) => userInputs.push({ task, question }),
  });
  const project = '/proj';
  return { deviaDir, store, uc, project, wakes, userInputs, cleanup: () => fs.rmSync(deviaDir, { recursive: true, force: true }) };
}

describe('KanbanUseCase — specs + tasks', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('mints sequential spec + task ids', () => {
    const s = fx.uc.createSpec(fx.project, 'My spec', 'desc');
    expect(s.id).toBe('S-1');
    const t1 = fx.uc.createTask(fx.project, s.id, 'A', 'body');
    const t2 = fx.uc.createTask(fx.project, s.id, 'B', 'body');
    expect(t1.id).toBe('T-1');
    expect(t2.id).toBe('T-2');
    expect(t1.column).toBe('backlog');
  });

  it('persists across store instances', () => {
    const s = fx.uc.createSpec(fx.project, 'persist', '');
    fx.uc.createTask(fx.project, s.id, 'keep', '');
    const fresh = new KanbanStore(() => fx.deviaDir);
    const board = fresh.boardView(fx.project);
    expect(board.specs).toHaveLength(1);
    expect(board.tasks).toHaveLength(1);
  });

  it('a task created with unmet deps starts blocked(dependency)', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const dep = fx.uc.createTask(fx.project, s.id, 'dep', '');
    const t = fx.uc.createTask(fx.project, s.id, 'needs dep', '', [dep.id]);
    expect(t.column).toBe('blocked');
    expect(t.blockReason).toBe('dependency');
  });
});

describe('KanbanUseCase — deleteTask', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('removes the task and returns true; false for an unknown id', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const t = fx.uc.createTask(fx.project, s.id, 'gone', '');
    expect(fx.uc.deleteTask(fx.project, t.id)).toBe(true);
    expect(fx.store.load(fx.project).tasks).toHaveLength(0);
    expect(fx.uc.deleteTask(fx.project, 'T-999')).toBe(false);
  });

  it('strips dangling references to the deleted task', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const dep = fx.uc.createTask(fx.project, s.id, 'dep', '');
    const dependent = fx.uc.createTask(fx.project, s.id, 'needs dep', '', [dep.id]);
    expect(dependent.dependsOn).toContain(dep.id);
    expect(dependent.blockTarget).toBe(dep.id);

    fx.uc.deleteTask(fx.project, dep.id);

    const fresh = fx.store.load(fx.project).tasks.find((t) => t.id === dependent.id);
    expect(fresh?.dependsOn).not.toContain(dep.id);
    expect(fresh?.blockTarget).toBeUndefined();
  });
});

describe('KanbanUseCase — updateTask (T-139)', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('edits title/body and reassigns specId to an existing spec', () => {
    const s1 = fx.uc.createSpec(fx.project, 's1', '');
    const s2 = fx.uc.createSpec(fx.project, 's2', '');
    const t = fx.uc.createTask(fx.project, s1.id, 'old', 'b');
    const updated = fx.uc.updateTask(fx.project, t.id, { title: 'new', body: 'b2', specId: s2.id });
    expect(updated?.title).toBe('new');
    expect(updated?.body).toBe('b2');
    expect(updated?.specId).toBe(s2.id);
  });

  it('ignores a specId that does not resolve to a spec', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const t = fx.uc.createTask(fx.project, s.id, 'x', '');
    const updated = fx.uc.updateTask(fx.project, t.id, { specId: 'S-999' });
    expect(updated?.specId).toBe(s.id);
  });

  it('clearing the last unmet dependency unblocks the task', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const dep = fx.uc.createTask(fx.project, s.id, 'dep', '');
    const t = fx.uc.createTask(fx.project, s.id, 'needs dep', '', [dep.id], { column: 'todo' });
    expect(t.column).toBe('blocked');
    const cleared = fx.uc.updateTask(fx.project, t.id, { dependsOn: [] });
    expect(cleared?.column).toBe('todo');
    expect(cleared?.blockReason).toBeUndefined();
    expect(cleared?.dependsOn).toHaveLength(0);
  });

  it('adding an unmet dependency to a live task blocks it', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const dep = fx.uc.createTask(fx.project, s.id, 'dep', '', [], { column: 'todo' });
    const t = fx.uc.createTask(fx.project, s.id, 'live', '', [], { column: 'todo' });
    expect(t.column).toBe('todo');
    const blocked = fx.uc.updateTask(fx.project, t.id, { dependsOn: [dep.id] });
    expect(blocked?.column).toBe('blocked');
    expect(blocked?.blockReason).toBe('dependency');
    expect(blocked?.blockTarget).toBe(dep.id);
  });

  it('drops self-references and unknown ids from dependsOn', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const t = fx.uc.createTask(fx.project, s.id, 'x', '');
    const updated = fx.uc.updateTask(fx.project, t.id, { dependsOn: [t.id, 'T-999'] });
    expect(updated?.dependsOn).toHaveLength(0);
  });

  it('returns null for an unknown task', () => {
    expect(fx.uc.updateTask(fx.project, 'T-999', { title: 'x' })).toBeNull();
  });
});

describe('KanbanUseCase — archive / reopen spec (T-140)', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('archives a spec with no open tasks and hides it from the board', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const t = fx.uc.createTask(fx.project, s.id, 'x', '');
    fx.uc.closeTask(fx.project, t.id);
    const res = fx.uc.archiveSpec(fx.project, s.id);
    expect(res.ok).toBe(true);
    const view = fx.store.boardView(fx.project);
    expect(view.specs).toHaveLength(0);
    expect(view.tasks).toHaveLength(0);
  });

  it('refuses to archive a spec with open tasks unless forced', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    fx.uc.createTask(fx.project, s.id, 'open', '', [], { column: 'todo' });
    const refused = fx.uc.archiveSpec(fx.project, s.id);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('open_tasks');
    expect(refused.openTasks).toBe(1);
    const forced = fx.uc.archiveSpec(fx.project, s.id, { force: true });
    expect(forced.ok).toBe(true);
  });

  it('reports not_found / already_archived', () => {
    expect(fx.uc.archiveSpec(fx.project, 'S-999').reason).toBe('not_found');
    const s = fx.uc.createSpec(fx.project, 's', '');
    fx.uc.archiveSpec(fx.project, s.id, { force: true });
    expect(fx.uc.archiveSpec(fx.project, s.id).reason).toBe('already_archived');
  });

  it('reopen restores the spec to the board', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    fx.uc.archiveSpec(fx.project, s.id, { force: true });
    expect(fx.store.boardView(fx.project).specs).toHaveLength(0);
    expect(fx.uc.reopenSpec(fx.project, s.id)).toBe(true);
    expect(fx.store.boardView(fx.project).specs).toHaveLength(1);
    expect(fx.uc.reopenSpec(fx.project, s.id)).toBe(false); // not archived anymore
  });
});

describe('KanbanUseCase — move + agent wake', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('moving into in_progress wakes the agent with reason=started', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const t = fx.uc.createTask(fx.project, s.id, 'x', '');
    fx.uc.moveTask(fx.project, t.id, 'in_progress');
    expect(fx.wakes).toHaveLength(1);
    expect(fx.wakes[0]?.reason).toBe('started');
  });

  it('moving out of blocked clears block fields', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const t = fx.uc.createTask(fx.project, s.id, 'x', '');
    fx.uc.blockTask(fx.project, t.id, 'user', '¿qué hago?');
    const moved = fx.uc.moveTask(fx.project, t.id, 'todo', { viaUser: true });
    expect(moved?.column).toBe('todo');
    expect(moved?.blockReason).toBeUndefined();
  });
});

describe('KanbanUseCase — block model (T6)', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('blocked(user) fires onUserInputRequest', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const t = fx.uc.createTask(fx.project, s.id, 'x', '');
    fx.uc.requestUserInput(fx.project, t.id, '¿prod o staging?');
    expect(fx.userInputs).toHaveLength(1);
    expect(fx.userInputs[0]?.question).toBe('¿prod o staging?');
  });

  it('user reply to a user-blocked task unblocks + wakes agent (user_reply)', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const t = fx.uc.createTask(fx.project, s.id, 'x', '');
    fx.uc.moveTask(fx.project, t.id, 'in_progress'); // wake #1
    fx.uc.requestUserInput(fx.project, t.id, 'q');
    const after = fx.uc.comment(fx.project, t.id, 'user', 'usa staging');
    expect(after?.column).toBe('in_progress');
    expect(after?.blockReason).toBeUndefined();
    expect(fx.wakes.at(-1)?.reason).toBe('user_reply');
  });

  it('dependency auto-resolves when target closes + wakes dependent', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const dep = fx.uc.createTask(fx.project, s.id, 'dep', '');
    const t = fx.uc.createTask(fx.project, s.id, 'needs dep', '', [dep.id]);
    expect(t.column).toBe('blocked');
    fx.uc.closeTask(fx.project, dep.id);
    const refreshed = fx.store.taskView(fx.project, t.id);
    expect(refreshed?.column).toBe('backlog');
    expect(fx.wakes.at(-1)?.reason).toBe('dependency_resolved');
  });

  it('subagent invocation blocks; agent synthesis comment unblocks', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const t = fx.uc.createTask(fx.project, s.id, 'x', '');
    fx.uc.moveTask(fx.project, t.id, 'in_progress');
    fx.uc.recordSubagentInvocation(fx.project, t.id, 'frontend-reviewer', 'review the diff');
    let v = fx.store.taskView(fx.project, t.id);
    expect(v?.column).toBe('blocked');
    expect(v?.blockReason).toBe('subagent');
    fx.uc.comment(fx.project, t.id, 'agent', 'Reviewer found 2 issues, fixed both.');
    v = fx.store.taskView(fx.project, t.id);
    expect(v?.column).toBe('in_progress');
    expect(v?.subagentLog[0]?.returnedAt).toBeDefined();
  });
});

describe('KanbanUseCase — thread + unread', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('agent messages start unread; markThreadRead clears them', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const t = fx.uc.createTask(fx.project, s.id, 'x', '');
    fx.uc.comment(fx.project, t.id, 'agent', 'working on it');
    let card = fx.store.boardView(fx.project).tasks.find((c) => c.id === t.id);
    expect(card?.unreadCount).toBe(1);
    fx.uc.markThreadRead(fx.project, t.id);
    card = fx.store.boardView(fx.project).tasks.find((c) => c.id === t.id);
    expect(card?.unreadCount).toBe(0);
  });

  it('linkCommit records a commit + sets hasCommit', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    const t = fx.uc.createTask(fx.project, s.id, 'x', '');
    fx.uc.linkCommit(fx.project, t.id, 'abc1234def');
    const card = fx.store.boardView(fx.project).tasks.find((c) => c.id === t.id);
    expect(card?.hasCommit).toBe(true);
  });
});
