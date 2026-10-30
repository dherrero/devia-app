import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KanbanStore } from '../kanban/infrastructure/kanban-store';
import { KanbanUseCase } from '../kanban/application/kanban.use-case';
import { PrepareUseCase } from './prepare.use-case';

describe('PrepareUseCase', () => {
  let dir: string;
  let prepare: PrepareUseCase;
  let kanban: KanbanUseCase;
  const project = '/tmp/demo-project';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-prep-'));
    const store = new KanbanStore(() => dir);
    kanban = new KanbanUseCase(store);
    prepare = new PrepareUseCase(kanban);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prepare() returns a plan-mode prompt mentioning the project + kanban tools', () => {
    const result = prepare.prepare('my-app');
    expect(result.mode).toBe('plan');
    expect(result.specId).toBeUndefined();
    expect(result.prompt).toContain('my-app');
    expect(result.prompt).toContain('kanban_create_task');
    expect(result.prompt).toContain('AGENTS.md');
  });

  it('init() creates a seed spec and returns its id + an expansion prompt', () => {
    const result = prepare.init(project, 'my-app', 'Build a todo list with sync', 'Todo app');
    expect(result.specId).toBe('S-1');
    expect(result.prompt).toContain('S-1');
    expect(result.prompt).toContain('Build a todo list with sync');
    // Plan mode is read-only: AGENTS.md is delegated to the first task, never
    // created during planning (the codex read-only sandbox rejects writes).
    expect(result.prompt).toContain('do NOT create or modify ANY files');
    expect(result.prompt).toContain('FIRST task must include creating AGENTS.md');

    const board = new KanbanStore(() => dir).boardView(project);
    expect(board.specs).toHaveLength(1);
    expect(board.specs[0]?.id).toBe('S-1');
    expect(board.specs[0]?.title).toBe('Todo app');
  });

  it('init() derives a title from the intent when none is given', () => {
    const result = prepare.init(project, 'my-app', 'Add OAuth login. Then dashboards.');
    const board = new KanbanStore(() => dir).boardView(project);
    expect(board.specs[0]?.title).toBe('Add OAuth login');
    expect(result.specId).toBe('S-1');
  });

  it('prompts pin the reply language to the UI language', () => {
    expect(prepare.prepare('my-app', 'es').prompt)
      .toContain('Write every conversational reply to the user in Spanish');
    expect(prepare.init(project, 'my-app', 'Build it', undefined, 'es').prompt)
      .toContain('Write every conversational reply to the user in Spanish');
    // Unknown / missing codes fall back to English (mirrors the UI fallback).
    expect(prepare.prepare('my-app', 'xx').prompt)
      .toContain('reply to the user in English');
    expect(prepare.prepare('my-app').prompt)
      .toContain('reply to the user in English');
    // Regional variants resolve by primary subtag (app.getLocale() form).
    expect(prepare.prepare('my-app', 'es-ES').prompt)
      .toContain('reply to the user in Spanish');
  });
});
