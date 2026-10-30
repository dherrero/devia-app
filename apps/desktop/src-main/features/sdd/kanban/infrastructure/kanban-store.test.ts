import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { KanbanStore } from './kanban-store';
import { KanbanUseCase } from '../application/kanban.use-case';

function setup() {
  const deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-kstore-'));
  const store = new KanbanStore(() => deviaDir);
  const uc = new KanbanUseCase(store);
  const project = '/proj';
  return { deviaDir, store, uc, project, cleanup: () => fs.rmSync(deviaDir, { recursive: true, force: true }) };
}

describe('KanbanStore — archived spec visibility (T-140)', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('boardView hides archived specs + their tasks by default, shows with includeArchived', () => {
    const open = fx.uc.createSpec(fx.project, 'open', '');
    const gone = fx.uc.createSpec(fx.project, 'gone', '');
    fx.uc.createTask(fx.project, open.id, 'keep', '');
    fx.uc.createTask(fx.project, gone.id, 'hidden', '');
    fx.uc.archiveSpec(fx.project, gone.id, { force: true });

    const def = fx.store.boardView(fx.project);
    expect(def.specs.map((s) => s.id)).toEqual([open.id]);
    expect(def.tasks).toHaveLength(1);

    const all = fx.store.boardView(fx.project, { includeArchived: true });
    expect(all.specs).toHaveLength(2);
    expect(all.tasks).toHaveLength(2);
  });

  it('archivedAt survives a reload from disk', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    fx.uc.archiveSpec(fx.project, s.id, { force: true });
    const fresh = new KanbanStore(() => fx.deviaDir);
    expect(fresh.boardView(fx.project).specs).toHaveLength(0);
    expect(fresh.boardView(fx.project, { includeArchived: true }).specs).toHaveLength(1);
  });
});

describe('KanbanStore — specSummaries (T-141)', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('counts tasks per column and excludes archived by default', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    fx.uc.createTask(fx.project, s.id, 'a', '', [], { column: 'todo' });
    const b = fx.uc.createTask(fx.project, s.id, 'b', '', [], { column: 'todo' });
    fx.uc.closeTask(fx.project, b.id);

    const [summary] = fx.store.specSummaries(fx.project);
    expect(summary?.totalTasks).toBe(2);
    expect(summary?.taskCounts.todo).toBe(1);
    expect(summary?.taskCounts.done).toBe(1);
    expect(summary?.archived).toBe(false);

    fx.uc.archiveSpec(fx.project, s.id, { force: true });
    expect(fx.store.specSummaries(fx.project)).toHaveLength(0);
    expect(fx.store.specSummaries(fx.project, { includeArchived: true })).toHaveLength(1);
  });
});

describe('KanbanStore — listBoard pagination + filters (T-141)', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('paginates tasks and reports total/hasMore', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    for (let i = 0; i < 5; i++) fx.uc.createTask(fx.project, s.id, `t${i}`, 'body');

    const page1 = fx.store.listBoard(fx.project, { limit: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.tasks).toHaveLength(2);
    expect(page1.hasMore).toBe(true);

    const page3 = fx.store.listBoard(fx.project, { limit: 2, offset: 4 });
    expect(page3.tasks).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
  });

  it('omits the body unless verbose', () => {
    const s = fx.uc.createSpec(fx.project, 's', '');
    fx.uc.createTask(fx.project, s.id, 't', 'the body');
    expect(fx.store.listBoard(fx.project).tasks[0]).not.toHaveProperty('body');
    expect(fx.store.listBoard(fx.project, { verbose: true }).tasks[0]?.body).toBe('the body');
  });

  it('filters by specId and column', () => {
    const s1 = fx.uc.createSpec(fx.project, 's1', '');
    const s2 = fx.uc.createSpec(fx.project, 's2', '');
    fx.uc.createTask(fx.project, s1.id, 'a', '', [], { column: 'todo' });
    fx.uc.createTask(fx.project, s2.id, 'b', '', [], { column: 'todo' });
    const c = fx.uc.createTask(fx.project, s1.id, 'c', '', [], { column: 'todo' });
    fx.uc.moveTask(fx.project, c.id, 'in_progress');

    expect(fx.store.listBoard(fx.project, { specId: s1.id }).total).toBe(2);
    expect(fx.store.listBoard(fx.project, { column: 'in_progress' }).total).toBe(1);
    expect(fx.store.listBoard(fx.project, { specId: s1.id, column: 'todo' }).total).toBe(1);
  });
});
