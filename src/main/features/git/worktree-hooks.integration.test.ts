import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGitFeature } from './index';
import { worktreeRefFor } from './domain/worktree-ref';
import type { ConfigRepository, WorktreeLifecycleHooks } from '../../shared/ports';

const SID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!gitAvailable())('git feature worktree hooks (real git)', () => {
  let tmp: string;
  let repo: string;
  let devia: string;

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  };
  const build = (hooks: WorktreeLifecycleHooks) =>
    buildGitFeature({
      config: { deviaDir: () => devia, get: () => ({ workspaceRoot: tmp }) } as unknown as ConfigRepository,
      worktreeHooks: hooks,
    }).exports;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-wt-hooks-')));
    repo = path.join(tmp, 'repo');
    devia = path.join(tmp, 'devia');
    fs.mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('create, reattach and cleanup notify the hooks; a throwing hook never changes the result', () => {
    const onCreated = vi.fn(() => {
      throw new Error('boom');
    });
    const onRemoved = vi.fn(() => {
      throw new Error('boom');
    });
    const exp = build({ onCreated, onRemoved });
    const ref = worktreeRefFor(devia, repo, SID);

    expect(exp.ensureSessionWorktree(ref)).toEqual({ ok: true, created: true });
    expect(onCreated).toHaveBeenCalledWith({ baseProject: repo, worktreePath: ref.worktreeDir, sessionId: SID });
    expect(fs.existsSync(ref.worktreeDir)).toBe(true);

    expect(exp.ensureSessionWorktree(ref)).toEqual({ ok: true, created: false });
    expect(onCreated).toHaveBeenCalledTimes(1);

    git('worktree', 'remove', '--force', ref.worktreeDir);
    expect(exp.reattachSessionWorktree(repo, SID, ref.branch)).toBe(ref.worktreeDir);
    expect(onCreated).toHaveBeenCalledTimes(2);

    const res = exp.cleanupSessionWorktree(repo, SID);
    expect(res).toMatchObject({ removed: true });
    expect(onRemoved).toHaveBeenCalledWith({ worktreePath: ref.worktreeDir });
  });
});
