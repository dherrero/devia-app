import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { cleanupSession, sweepOrphans } from './worktree-lifecycle';
import type { GitExecFn } from './cli-git-worktree-manager';
import type { WorktreeRef } from '../domain/worktree-ref';

const REF: WorktreeRef = {
  baseProject: '/repos/myapp',
  sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
  worktreeDir: '/home/u/.devia-app/worktrees/repos-myapp/a1b2c3d4-e5f6-7890-abcd-ef0123456789',
  branch: 'devia/session-a1b2c3d4',
};

// ---------------------------------------------------------------------------
// cleanupSession
// ---------------------------------------------------------------------------

describe('cleanupSession', () => {
  it('calls worktree remove --force, then prune, then branch -D with correct cwd', () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const exec: GitExecFn = vi.fn((_cmd, args, opts) => {
      calls.push({ args, cwd: opts.cwd as string });
      return Buffer.from('');
    });

    const result = cleanupSession(REF, exec);

    expect(calls).toHaveLength(3);
    expect(calls[0]!.args).toEqual(['worktree', 'remove', '--force', REF.worktreeDir]);
    expect(calls[0]!.cwd).toBe(REF.baseProject);
    expect(calls[1]!.args).toEqual(['worktree', 'prune']);
    expect(calls[1]!.cwd).toBe(REF.baseProject);
    expect(calls[2]!.args).toEqual(['branch', '-D', REF.branch]);
    expect(calls[2]!.cwd).toBe(REF.baseProject);
    expect(result).toEqual({ removed: true, branchDeleted: true });
  });

  it('returns removed:false when worktree remove throws but still attempts prune and branch -D', () => {
    const calls: Array<readonly string[]> = [];
    const exec: GitExecFn = vi.fn((_cmd, args) => {
      calls.push(args);
      if (args[1] === 'remove') {
        const err = new Error('no such worktree') as Error & { stderr: Buffer };
        err.stderr = Buffer.from('no such worktree');
        throw err;
      }
      return Buffer.from('');
    });

    const result = cleanupSession(REF, exec);

    // remove threw → removed:false; prune + branch -D still ran
    expect(result.removed).toBe(false);
    expect(result.branchDeleted).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(['worktree', 'prune']);
    expect(calls[2]).toEqual(['branch', '-D', REF.branch]);
  });

  it('swallows branch -D failure and still reports removed:true', () => {
    const exec: GitExecFn = vi.fn((_cmd, args) => {
      if (args[1] === '-D' || (args[0] === 'branch' && args[1] === '-D')) {
        throw new Error('branch not found');
      }
      return Buffer.from('');
    });

    const result = cleanupSession(REF, exec);

    expect(result.removed).toBe(true);
    expect(result.branchDeleted).toBe(false);
  });

  it('never throws even when all three git calls fail', () => {
    const exec: GitExecFn = vi.fn(() => {
      throw new Error('git not found');
    });

    expect(() => cleanupSession(REF, exec)).not.toThrow();
    const result = cleanupSession(REF, exec);
    expect(result).toEqual({ removed: false, branchDeleted: false });
  });
});

// ---------------------------------------------------------------------------
// sweepOrphans
// ---------------------------------------------------------------------------

describe('sweepOrphans', () => {
  const DEVIA_DIR = '/home/u/.devia-app';
  const ROOT = path.join(DEVIA_DIR, 'worktrees');
  const KEY = 'home-u-repos-myapp';
  const SID_1 = 'aaaaaaaa-0000-0000-0000-000000000001';
  const SID_2 = 'bbbbbbbb-0000-0000-0000-000000000002';
  const WT_1 = path.join(ROOT, KEY, SID_1);
  const WT_2 = path.join(ROOT, KEY, SID_2);
  const BASE = '/home/u/repos/myapp';

  function makeExec(baseForRevParse: string): GitExecFn {
    return vi.fn((_cmd, args) => {
      if (args[0] === '-C' && args[2] === 'rev-parse') {
        // Return the .git dir of the base project
        return Buffer.from(`${baseForRevParse}/.git\n`);
      }
      return Buffer.from('');
    });
  }

  function makeFsOps(existingDirs: Map<string, string[]>) {
    return {
      existsSync: vi.fn((p: string) => existingDirs.has(p)),
      readdirSync: vi.fn((p: string): string[] => existingDirs.get(p) ?? []),
      rmSync: vi.fn((_p: string, _opts: { recursive: boolean; force: boolean }) => undefined),
    };
  }

  it('sweeps all orphan worktree dirs when live set is empty', () => {
    const dirs = new Map<string, string[]>([
      [ROOT, [KEY]],
      [path.join(ROOT, KEY), [SID_1, SID_2]],
    ]);
    const exec = makeExec(BASE);
    const fsOps = makeFsOps(dirs);

    const result = sweepOrphans(DEVIA_DIR, new Set(), exec, fsOps);

    expect(result.swept).toHaveLength(2);
    expect(result.swept).toContain(WT_1);
    expect(result.swept).toContain(WT_2);
  });

  it('preserves a worktree dir that is in the live set', () => {
    const dirs = new Map<string, string[]>([
      [ROOT, [KEY]],
      [path.join(ROOT, KEY), [SID_1, SID_2]],
    ]);
    const exec = makeExec(BASE);
    const fsOps = makeFsOps(dirs);

    // WT_1 is live — only WT_2 should be swept
    const result = sweepOrphans(DEVIA_DIR, new Set([WT_1]), exec, fsOps);

    expect(result.swept).toHaveLength(1);
    expect(result.swept).toContain(WT_2);
    expect(result.swept).not.toContain(WT_1);
  });

  it('returns empty swept array when the worktrees root does not exist', () => {
    const fsOps = {
      existsSync: vi.fn(() => false),
      readdirSync: vi.fn(() => [] as string[]),
      rmSync: vi.fn(),
    };
    const exec: GitExecFn = vi.fn(() => Buffer.from(''));

    const result = sweepOrphans(DEVIA_DIR, new Set(), exec, fsOps);

    expect(result.swept).toHaveLength(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('falls back to rmSync when rev-parse fails (broken worktree)', () => {
    const dirs = new Map<string, string[]>([
      [ROOT, [KEY]],
      [path.join(ROOT, KEY), [SID_1]],
    ]);
    const exec: GitExecFn = vi.fn(() => {
      throw new Error('not a git repository');
    });
    const fsOps = makeFsOps(dirs);

    const result = sweepOrphans(DEVIA_DIR, new Set(), exec, fsOps);

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0]).toBe(WT_1);
    expect(fsOps.rmSync).toHaveBeenCalledWith(WT_1, { recursive: true, force: true });
  });

  it('uses git worktree remove + prune with the resolved base project path', () => {
    const dirs = new Map<string, string[]>([
      [ROOT, [KEY]],
      [path.join(ROOT, KEY), [SID_1]],
    ]);
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const exec: GitExecFn = vi.fn((_cmd, args, opts) => {
      calls.push({ args, cwd: opts.cwd as string });
      if (args[0] === '-C' && args[2] === 'rev-parse') {
        return Buffer.from(`${BASE}/.git\n`);
      }
      return Buffer.from('');
    });
    const fsOps = makeFsOps(dirs);

    sweepOrphans(DEVIA_DIR, new Set(), exec, fsOps);

    const removeCalls = calls.filter((c) => c.args[1] === 'remove');
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]!.args).toEqual(['worktree', 'remove', '--force', WT_1]);
    expect(removeCalls[0]!.cwd).toBe(BASE);

    const pruneCalls = calls.filter((c) => c.args[1] === 'prune');
    expect(pruneCalls).toHaveLength(1);
    expect(pruneCalls[0]!.cwd).toBe(BASE);
  });

  it('does not call rmSync when git-based removal succeeds', () => {
    const dirs = new Map<string, string[]>([
      [ROOT, [KEY]],
      [path.join(ROOT, KEY), [SID_1]],
    ]);
    const exec = makeExec(BASE);
    const fsOps = makeFsOps(dirs);

    sweepOrphans(DEVIA_DIR, new Set(), exec, fsOps);

    expect(fsOps.rmSync).not.toHaveBeenCalled();
  });

  it('handles an empty worktrees root gracefully (no project key dirs)', () => {
    const dirs = new Map<string, string[]>([[ROOT, []]]);
    const exec: GitExecFn = vi.fn(() => Buffer.from(''));
    const fsOps = makeFsOps(dirs);

    const result = sweepOrphans(DEVIA_DIR, new Set(), exec, fsOps);

    expect(result.swept).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Real-fs integration: create temp dir structure, inject fake exec
// ---------------------------------------------------------------------------

describe('sweepOrphans with real temp fs', () => {
  it('detects and removes orphan directories on the real filesystem', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-sweep-test-'));
    const deviaDir = path.join(tmpBase, '.devia-app');
    const key = 'home-u-repos-myapp';
    const sid = 'cccccccc-1111-1111-1111-000000000001';
    const wtDir = path.join(deviaDir, 'worktrees', key, sid);
    fs.mkdirSync(wtDir, { recursive: true });

    // Fake exec: rev-parse succeeds, remove+prune succeed
    const baseProject = '/home/u/repos/myapp';
    const calls: Array<readonly string[]> = [];
    const exec: GitExecFn = vi.fn((_cmd, args) => {
      calls.push(args);
      if (args[0] === '-C') {
        return Buffer.from(`${baseProject}/.git\n`);
      }
      return Buffer.from('');
    });

    const result = sweepOrphans(deviaDir, new Set(), exec);

    // The directory should have been swept (reported in swept[])
    expect(result.swept).toContain(wtDir);
    // git worktree remove was called with the correct worktreeDir
    const removeCalls = calls.filter((a) => a[1] === 'remove');
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]![3]).toBe(wtDir);

    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('does not sweep a dir in liveWorktreeDirs', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-sweep-live-'));
    const deviaDir = path.join(tmpBase, '.devia-app');
    const key = 'home-u-repos-myapp';
    const sid = 'dddddddd-2222-2222-2222-000000000002';
    const wtDir = path.join(deviaDir, 'worktrees', key, sid);
    fs.mkdirSync(wtDir, { recursive: true });

    const exec: GitExecFn = vi.fn(() => Buffer.from('/fake/.git\n'));

    const result = sweepOrphans(deviaDir, new Set([wtDir]), exec);

    expect(result.swept).not.toContain(wtDir);
    // directory still exists
    expect(fs.existsSync(wtDir)).toBe(true);

    fs.rmSync(tmpBase, { recursive: true, force: true });
  });
});
