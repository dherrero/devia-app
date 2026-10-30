import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { MemoryStore } from './memory-store';
import { migrateWorktreeMemoryStores } from './worktree-memory-migration';

const SESSION_A = '11111111-2222-3333-4444-555555555555';
const SESSION_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('migrateWorktreeMemoryStores', () => {
  let tmp: string;
  let deviaDir: string;
  let baseProject: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-mem-migration-'));
    deviaDir = path.join(tmp, '.devia-app');
    baseProject = path.join(tmp, 'ws', 'proj-a');
    fs.mkdirSync(path.join(deviaDir, 'projects'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function worktreePath(sessionId: string): string {
    return path.join(deviaDir, 'worktrees', baseProject.replace(/[/\\:]/g, '-').replace(/^-/, ''), sessionId);
  }

  /** Writes an observation into the store keyed by `projectPath`, exactly as
   *  the pre-fix MCP server did when handed a worktree cwd. */
  function seedOrphan(sessionId: string, title: string): void {
    const store = new MemoryStore(() => deviaDir);
    store.appendObservation({
      scope: 'project',
      projectPath: worktreePath(sessionId),
      sessionId,
      type: 'manual',
      title,
      content: `content of ${title}`,
    });
  }

  function baseStore(): MemoryStore {
    return new MemoryStore(() => deviaDir);
  }

  it('merges orphan worktree-keyed stores into the base project store', () => {
    seedOrphan(SESSION_A, 'resumen graphify');
    seedOrphan(SESSION_B, 'otra nota');

    const result = migrateWorktreeMemoryStores(deviaDir);

    expect(result.mergedStores).toBe(2);
    expect(result.observations).toBe(2);
    const hits = baseStore().search('project', baseProject, { query: 'graphify' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.observation.title).toBe('resumen graphify');
    const all = baseStore().load('project', baseProject).observations;
    expect(all).toHaveLength(2);
    expect(new Set(all.map((o) => o.id)).size).toBe(2);
  });

  it('is idempotent: a second run merges nothing', () => {
    seedOrphan(SESSION_A, 'resumen graphify');
    expect(migrateWorktreeMemoryStores(deviaDir).mergedStores).toBe(1);

    const again = migrateWorktreeMemoryStores(deviaDir);
    expect(again.mergedStores).toBe(0);
    expect(baseStore().load('project', baseProject).observations).toHaveLength(1);
  });

  it('keeps existing base entries and re-sequences merged ids after them', () => {
    baseStore().appendObservation({
      scope: 'project',
      projectPath: baseProject,
      sessionId: 'base-session',
      type: 'manual',
      title: 'ya estaba en el proyecto',
      content: '',
    });
    seedOrphan(SESSION_A, 'venida del worktree');

    migrateWorktreeMemoryStores(deviaDir);

    const doc = baseStore().load('project', baseProject);
    expect(doc.observations.map((o) => o.title)).toEqual([
      'ya estaba en el proyecto',
      'venida del worktree',
    ]);
    expect(doc.observations[1]?.id).toBe('obs-2');
  });

  it('preserves the original orphan data as memory.json.migrated', () => {
    seedOrphan(SESSION_A, 'resumen graphify');
    const orphanDir = path.join(deviaDir, 'projects', MemoryStore.keyForPath(worktreePath(SESSION_A)));

    migrateWorktreeMemoryStores(deviaDir);

    expect(fs.existsSync(path.join(orphanDir, 'memory.json'))).toBe(false);
    expect(fs.existsSync(path.join(orphanDir, 'memory.json.migrated'))).toBe(true);
  });

  it('ignores project dirs that are not session-worktree keys', () => {
    baseStore().appendObservation({
      scope: 'project',
      projectPath: baseProject,
      sessionId: 's',
      type: 'manual',
      title: 'normal',
      content: '',
    });

    const result = migrateWorktreeMemoryStores(deviaDir);

    expect(result.mergedStores).toBe(0);
    expect(baseStore().load('project', baseProject).observations).toHaveLength(1);
  });

  it('returns zeros when the projects dir does not exist', () => {
    const result = migrateWorktreeMemoryStores(path.join(tmp, 'nope'));
    expect(result).toEqual({ mergedStores: 0, observations: 0, sessions: 0, prompts: 0 });
  });

  it('migrates session summaries and prompts too', () => {
    const store = new MemoryStore(() => deviaDir);
    const orphanPath = worktreePath(SESSION_A);
    store.appendSession({
      scope: 'project',
      projectPath: orphanPath,
      project: 'proj-a',
      directory: orphanPath,
      startedAt: 1000,
      sessionId: SESSION_A,
      summary: 'resumen de la sesión',
    });
    store.appendPrompt({
      scope: 'project',
      projectPath: orphanPath,
      sessionId: SESSION_A,
      content: 'haz una cosa',
      createdAt: 1000,
    });

    const result = migrateWorktreeMemoryStores(deviaDir);

    expect(result.sessions).toBe(1);
    expect(result.prompts).toBe(1);
    const doc = baseStore().load('project', baseProject).sessions;
    expect(doc[0]?.summary).toBe('resumen de la sesión');
  });
});
