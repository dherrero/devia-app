import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KanbanStore } from '../kanban/infrastructure/kanban-store';
import { KanbanUseCase } from '../kanban/application/kanban.use-case';
import { KANBAN_TOOLS, advertisedKanbanTools, callKanbanTool } from './kanban-tools';

describe('kanban MCP tools (T5)', () => {
  let dir: string;
  let store: KanbanStore;
  let deps: { useCase: KanbanUseCase; store: KanbanStore; projectPath: string };
  const project = '/tmp/mcp-demo';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-mcp-'));
    store = new KanbanStore(() => dir);
    deps = { useCase: new KanbanUseCase(store), store, projectPath: project };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('advertises every tool with a name + input schema', () => {
    expect(KANBAN_TOOLS.length).toBeGreaterThanOrEqual(13);
    for (const t of KANBAN_TOOLS) {
      expect(t.name).toMatch(/^kanban_/);
      expect(t.inputSchema['type']).toBe('object');
    }
    const names = KANBAN_TOOLS.map((t) => t.name);
    for (const n of ['kanban_update_task', 'kanban_archive_spec', 'kanban_reopen_spec', 'kanban_list_specs']) {
      expect(names).toContain(n);
    }
  });

  it('creates a spec then a task and lists the board', () => {
    const specMsg = callKanbanTool(deps, 'kanban_create_spec', { title: 'Auth' });
    expect(specMsg).toContain('S-1');
    const taskMsg = callKanbanTool(deps, 'kanban_create_task', { specId: 'S-1', title: 'Login' });
    expect(taskMsg).toContain('T-1');

    const listed = JSON.parse(callKanbanTool(deps, 'kanban_list', {}));
    expect(listed.specs).toHaveLength(1);
    expect(listed.tasks).toHaveLength(1);
  });

  it('moves and closes a task', () => {
    callKanbanTool(deps, 'kanban_create_spec', { title: 'S' });
    callKanbanTool(deps, 'kanban_create_task', { specId: 'S-1', title: 'X' });
    callKanbanTool(deps, 'kanban_move_task', { taskId: 'T-1', column: 'in_progress' });
    callKanbanTool(deps, 'kanban_close_task', { taskId: 'T-1', commit: 'abc1234' });

    const view = JSON.parse(callKanbanTool(deps, 'kanban_get_task', { taskId: 'T-1' }));
    expect(view.column).toBe('done');
    expect(view.closingCommit).toBe('abc1234');
  });

  it('request_user_input blocks the task on the user', () => {
    callKanbanTool(deps, 'kanban_create_spec', { title: 'S' });
    callKanbanTool(deps, 'kanban_create_task', { specId: 'S-1', title: 'X' });
    callKanbanTool(deps, 'kanban_move_task', { taskId: 'T-1', column: 'in_progress' });
    const msg = callKanbanTool(deps, 'kanban_request_user_input', { taskId: 'T-1', question: '¿Qué color?' });
    expect(msg).toContain('blocked');

    const view = JSON.parse(callKanbanTool(deps, 'kanban_get_task', { taskId: 'T-1' }));
    expect(view.column).toBe('blocked');
    expect(view.blockReason).toBe('user');
  });

  it('rejects an invalid column and unknown tool', () => {
    callKanbanTool(deps, 'kanban_create_spec', { title: 'S' });
    callKanbanTool(deps, 'kanban_create_task', { specId: 'S-1', title: 'X' });
    expect(() => callKanbanTool(deps, 'kanban_move_task', { taskId: 'T-1', column: 'nope' })).toThrow();
    expect(() => callKanbanTool(deps, 'kanban_does_not_exist', {})).toThrow();
  });

  it('kanban_update_task fixes a wrong dependency and unblocks (T-139)', () => {
    callKanbanTool(deps, 'kanban_create_spec', { title: 'S' });
    callKanbanTool(deps, 'kanban_create_task', { specId: 'S-1', title: 'dep' });        // T-1
    callKanbanTool(deps, 'kanban_create_task', { specId: 'S-1', title: 'real-dep' });    // T-2
    // T-3 created depending on the WRONG task (T-1) → blocked.
    callKanbanTool(deps, 'kanban_create_task', { specId: 'S-1', title: 'work', dependsOn: ['T-1'], column: 'todo' });
    let v = JSON.parse(callKanbanTool(deps, 'kanban_get_task', { taskId: 'T-3' }));
    expect(v.column).toBe('blocked');

    // Fix: clear the dependency entirely → unblocks back to todo.
    callKanbanTool(deps, 'kanban_update_task', { taskId: 'T-3', dependsOn: [] });
    v = JSON.parse(callKanbanTool(deps, 'kanban_get_task', { taskId: 'T-3' }));
    expect(v.column).toBe('todo');
    expect(v.dependsOn).toHaveLength(0);

    expect(() => callKanbanTool(deps, 'kanban_update_task', { taskId: 'T-999', title: 'x' })).toThrow();
  });

  it('archives and reopens a spec, hiding it from list/list_specs (T-140)', () => {
    callKanbanTool(deps, 'kanban_create_spec', { title: 'A' });   // S-1
    callKanbanTool(deps, 'kanban_create_spec', { title: 'B' });   // S-2
    callKanbanTool(deps, 'kanban_create_task', { specId: 'S-2', title: 'x' });
    callKanbanTool(deps, 'kanban_close_task', { taskId: 'T-1' });

    expect(callKanbanTool(deps, 'kanban_archive_spec', { specId: 'S-2' })).toContain('Archived');
    const specs = JSON.parse(callKanbanTool(deps, 'kanban_list_specs', {}));
    expect(specs.map((s: { id: string }) => s.id)).toEqual(['S-1']);
    const listed = JSON.parse(callKanbanTool(deps, 'kanban_list', {}));
    expect(listed.specs).toHaveLength(1);
    expect(listed.tasks).toHaveLength(0);

    // includeArchived surfaces it again.
    expect(JSON.parse(callKanbanTool(deps, 'kanban_list_specs', { includeArchived: true }))).toHaveLength(2);

    callKanbanTool(deps, 'kanban_reopen_spec', { specId: 'S-2' });
    expect(JSON.parse(callKanbanTool(deps, 'kanban_list_specs', {}))).toHaveLength(2);
  });

  it('archive_spec refuses open tasks unless forced (T-140)', () => {
    callKanbanTool(deps, 'kanban_create_spec', { title: 'A' });
    callKanbanTool(deps, 'kanban_create_task', { specId: 'S-1', title: 'open', column: 'todo' });
    expect(() => callKanbanTool(deps, 'kanban_archive_spec', { specId: 'S-1' })).toThrow();
    expect(callKanbanTool(deps, 'kanban_archive_spec', { specId: 'S-1', force: true })).toContain('Archived');
  });

  it('kanban_list paginates and filters (T-141)', () => {
    callKanbanTool(deps, 'kanban_create_spec', { title: 'S' });
    for (let i = 0; i < 4; i++) callKanbanTool(deps, 'kanban_create_task', { specId: 'S-1', title: `t${i}`, column: 'todo' });

    const page = JSON.parse(callKanbanTool(deps, 'kanban_list', { limit: 2, offset: 0 }));
    expect(page.total).toBe(4);
    expect(page.tasks).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.tasks[0]).not.toHaveProperty('body');

    const verbose = JSON.parse(callKanbanTool(deps, 'kanban_list', { verbose: true, limit: 1 }));
    expect(verbose.tasks[0]).toHaveProperty('body');

    expect(() => callKanbanTool(deps, 'kanban_list', { column: 'nope' })).toThrow();
  });
});

describe('advertisedKanbanTools (S-16 T-188)', () => {
  it('advertises only the bootstrap tools on an empty board', () => {
    const names = advertisedKanbanTools(true).map((t) => t.name);
    expect(names).toEqual(['kanban_create_spec', 'kanban_create_task']);
  });

  it('advertises the full surface once the board has content', () => {
    expect(advertisedKanbanTools(false)).toBe(KANBAN_TOOLS);
    expect(advertisedKanbanTools(false).length).toBeGreaterThan(2);
  });

  it('bootstrap tools are a real subset of the full surface', () => {
    const full = new Set(KANBAN_TOOLS.map((t) => t.name));
    for (const t of advertisedKanbanTools(true)) expect(full.has(t.name)).toBe(true);
  });
});
