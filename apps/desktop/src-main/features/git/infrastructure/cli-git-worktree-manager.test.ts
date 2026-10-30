import { describe, it, expect, vi } from 'vitest';
import { CliGitWorktreeManager, parsePorcelainWorktreeList, ensureWorktreeSync, reattachWorktreeSync } from './cli-git-worktree-manager';
import type { GitExecFn } from './cli-git-worktree-manager';
import { WorktreeError } from '../domain/ports';
import type { WorktreeRef } from '../domain/worktree-ref';

const REF: WorktreeRef = {
  baseProject: '/repos/myapp',
  sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
  worktreeDir: '/home/u/.devia-app/worktrees/repos-myapp/a1b2c3d4-e5f6-7890-abcd-ef0123456789',
  branch: 'devia/session-a1b2c3d4',
};

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe('CliGitWorktreeManager.add', () => {
  it('calls git worktree add with the correct argv and cwd', async () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const exec = vi.fn().mockImplementation(
      (_cmd: string, args: readonly string[], opts: { cwd: string }) => {
        calls.push({ args, cwd: opts.cwd });
        return Buffer.from('');
      },
    );
    const mgr = new CliGitWorktreeManager(exec);

    await mgr.add(REF);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      'worktree', 'add', '-b', REF.branch, REF.worktreeDir, 'HEAD',
    ]);
    expect(calls[0]!.cwd).toBe(REF.baseProject);
  });

  it('uses the provided baseRef instead of HEAD', async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const exec = vi.fn().mockImplementation(
      (_cmd: string, args: readonly string[]) => {
        calls.push({ args });
        return Buffer.from('');
      },
    );
    const mgr = new CliGitWorktreeManager(exec);

    await mgr.add(REF, 'abc1234');

    expect(calls[0]!.args[5]).toBe('abc1234');
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe('CliGitWorktreeManager.remove', () => {
  it('calls worktree remove --force then worktree prune with correct cwd', async () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const exec = vi.fn().mockImplementation(
      (_cmd: string, args: readonly string[], opts: { cwd: string }) => {
        calls.push({ args, cwd: opts.cwd });
        return Buffer.from('');
      },
    );
    const mgr = new CliGitWorktreeManager(exec);

    await mgr.remove(REF);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(['worktree', 'remove', '--force', REF.worktreeDir]);
    expect(calls[1]!.args).toEqual(['worktree', 'prune']);
    expect(calls[0]!.cwd).toBe(REF.baseProject);
    expect(calls[1]!.cwd).toBe(REF.baseProject);
  });

  it('still calls prune even when remove throws', async () => {
    let callCount = 0;
    const exec = vi.fn().mockImplementation(
      (_cmd: string, args: readonly string[]) => {
        callCount += 1;
        // args = ['worktree', 'remove'|'prune', ...]
        if (args.includes('remove')) {
          const err = new Error('already checked out') as Error & { stderr: Buffer };
          err.stderr = Buffer.from('already checked out');
          throw err;
        }
        return Buffer.from('');
      },
    );
    const mgr = new CliGitWorktreeManager(exec);

    // remove throws a WorktreeError — but prune must still have been invoked.
    await expect(mgr.remove(REF)).rejects.toBeInstanceOf(WorktreeError);
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const PORCELAIN_SAMPLE = [
  'worktree /repos/myapp',
  'HEAD abc1234def5678901234567890abcdef12345678',
  'branch refs/heads/main',
  '',
  'worktree /home/u/.devia-app/worktrees/repos-myapp/sess-01',
  'HEAD 0000000000000000000000000000000000000001',
  'branch refs/heads/devia/session-a1b2c3d4',
  '',
  'worktree /tmp/detached-wt',
  'HEAD ffffffffffffffffffffffffffffffffffffffff',
  'detached',
  '',
].join('\n');

describe('parsePorcelainWorktreeList', () => {
  it('parses three records from sample porcelain output', () => {
    const result = parsePorcelainWorktreeList(PORCELAIN_SAMPLE);
    expect(result).toHaveLength(3);
  });

  it('extracts worktreeDir, head, and branch for a normal entry', () => {
    const result = parsePorcelainWorktreeList(PORCELAIN_SAMPLE);
    expect(result[0]).toEqual({
      worktreeDir: '/repos/myapp',
      head: 'abc1234def5678901234567890abcdef12345678',
      branch: 'main',
    });
  });

  it('strips the refs/heads/ prefix from branch names', () => {
    const result = parsePorcelainWorktreeList(PORCELAIN_SAMPLE);
    expect(result[1]!.branch).toBe('devia/session-a1b2c3d4');
  });

  it('omits branch for a detached HEAD worktree', () => {
    const result = parsePorcelainWorktreeList(PORCELAIN_SAMPLE);
    expect(result[2]).toEqual({
      worktreeDir: '/tmp/detached-wt',
      head: 'ffffffffffffffffffffffffffffffffffffffff',
    });
    expect('branch' in result[2]!).toBe(false);
  });

  it('returns an empty array for empty input', () => {
    expect(parsePorcelainWorktreeList('')).toEqual([]);
  });
});

describe('CliGitWorktreeManager.list', () => {
  it('passes the baseProject as cwd and returns parsed WorktreeInfo[]', async () => {
    const exec = vi.fn().mockReturnValue(Buffer.from(PORCELAIN_SAMPLE));
    const mgr = new CliGitWorktreeManager(exec);

    const result = await mgr.list('/repos/myapp');

    expect(exec).toHaveBeenCalledWith(
      'git',
      ['worktree', 'list', '--porcelain'],
      expect.objectContaining({ cwd: '/repos/myapp' }),
    );
    expect(result).toHaveLength(3);
    expect(result[0]!.branch).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('CliGitWorktreeManager error classification', () => {
  function makeExecThrowing(stderrText: string) {
    return vi.fn().mockImplementation(() => {
      const err = new Error(stderrText) as Error & { stderr: Buffer };
      err.stderr = Buffer.from(stderrText);
      throw err;
    });
  }

  it('classifies "not a git repository" as not-a-repo', async () => {
    const mgr = new CliGitWorktreeManager(makeExecThrowing('fatal: not a git repository'));
    await expect(mgr.add(REF)).rejects.toMatchObject({ code: 'not-a-repo' });
  });

  it('classifies "does not have any commits yet" as no-commits', async () => {
    const mgr = new CliGitWorktreeManager(
      makeExecThrowing("fatal: 'HEAD': does not have any commits yet"),
    );
    await expect(mgr.add(REF)).rejects.toMatchObject({ code: 'no-commits' });
  });

  it('classifies "invalid reference: HEAD" as no-commits', async () => {
    const mgr = new CliGitWorktreeManager(
      makeExecThrowing('fatal: invalid reference: HEAD'),
    );
    await expect(mgr.add(REF)).rejects.toMatchObject({ code: 'no-commits' });
  });

  it('classifies "a branch named … already exists" as branch-exists', async () => {
    const mgr = new CliGitWorktreeManager(
      makeExecThrowing("fatal: a branch named 'devia/session-a1b2c3d4' already exists"),
    );
    await expect(mgr.add(REF)).rejects.toMatchObject({ code: 'branch-exists' });
  });

  it('classifies "already checked out" as worktree-exists', async () => {
    const mgr = new CliGitWorktreeManager(
      makeExecThrowing('fatal: already checked out at that path'),
    );
    await expect(mgr.add(REF)).rejects.toMatchObject({ code: 'worktree-exists' });
  });

  it('classifies unrecognised errors as unknown', async () => {
    const mgr = new CliGitWorktreeManager(makeExecThrowing('some unexpected git error'));
    await expect(mgr.add(REF)).rejects.toMatchObject({ code: 'unknown' });
  });

  it('throws a WorktreeError instance for all classified errors', async () => {
    const mgr = new CliGitWorktreeManager(makeExecThrowing('fatal: not a git repository'));
    await expect(mgr.add(REF)).rejects.toBeInstanceOf(WorktreeError);
  });
});

// ---------------------------------------------------------------------------
// ensureWorktreeSync (T-153)
// ---------------------------------------------------------------------------

describe('ensureWorktreeSync', () => {
  function throwingExec(stderrText: string): GitExecFn {
    return () => {
      const e = new Error('git failed') as Error & { stderr: Buffer };
      e.stderr = Buffer.from(stderrText);
      throw e;
    };
  }

  it('returns created:false when the worktree is already registered', () => {
    const exec: GitExecFn = (_cmd, args) => {
      if (args[1] === 'list') {
        return Buffer.from(`worktree ${REF.worktreeDir}\nHEAD abc123\nbranch refs/heads/${REF.branch}\n`);
      }
      throw new Error('add should not be called');
    };
    expect(ensureWorktreeSync(REF, exec)).toEqual({ ok: true, created: false });
  });

  it('creates the worktree when absent and returns created:true', () => {
    const seen: string[] = [];
    const exec: GitExecFn = (_cmd, args) => {
      seen.push(args[1] as string);
      if (args[1] === 'list') return Buffer.from('worktree /repos/myapp\nHEAD abc\nbranch refs/heads/main\n');
      return Buffer.from('');
    };
    expect(ensureWorktreeSync(REF, exec)).toEqual({ ok: true, created: true });
    expect(seen).toContain('add');
  });

  it('S-3 F1.2: branches the session off the provided baseRef, HEAD when omitted', () => {
    const addArgs: string[][] = [];
    const exec: GitExecFn = (_cmd, args) => {
      if (args[1] === 'list') return Buffer.from('worktree /repos/myapp\nHEAD abc\nbranch refs/heads/main\n');
      addArgs.push([...args] as string[]);
      return Buffer.from('');
    };

    ensureWorktreeSync(REF, exec, 'main');
    expect(addArgs[0]?.at(-1)).toBe('main');

    ensureWorktreeSync(REF, exec);
    expect(addArgs[1]?.at(-1)).toBe('HEAD');
  });

  it('S-3 F2.2: reattachWorktreeSync recreates from an existing branch WITHOUT -b', () => {
    const calls: string[][] = [];
    const exec: GitExecFn = (_cmd, args) => {
      calls.push([...args] as string[]);
      return Buffer.from('');
    };

    expect(reattachWorktreeSync(REF, exec)).toBe(true);
    const add = calls.find((a) => a[1] === 'add');
    expect(add).toEqual(['worktree', 'add', REF.worktreeDir, REF.branch]);
  });

  it('S-3 F2.2: reattachWorktreeSync fails fast when the branch is gone', () => {
    const exec: GitExecFn = (_cmd, args) => {
      if (args[0] === 'rev-parse') throw new Error('fatal: Needed a single revision');
      return Buffer.from('');
    };
    expect(reattachWorktreeSync(REF, exec)).toBe(false);
  });

  it('returns ok:false code:no-commits on a repo without commits', () => {
    expect(ensureWorktreeSync(REF, throwingExec("fatal: 'HEAD': does not have any commits yet"))).toEqual({
      ok: false,
      code: 'no-commits',
    });
  });

  it('returns ok:false code:not-a-repo outside a git repo', () => {
    expect(ensureWorktreeSync(REF, throwingExec('fatal: not a git repository'))).toEqual({
      ok: false,
      code: 'not-a-repo',
    });
  });

  it('treats a pre-existing branch/worktree at the path as already present', () => {
    const exec: GitExecFn = (_cmd, args) => {
      if (args[1] === 'list') return Buffer.from('worktree /repos/myapp\nHEAD abc\nbranch refs/heads/main\n');
      const e = new Error('git failed') as Error & { stderr: Buffer };
      e.stderr = Buffer.from("fatal: a branch named 'devia/session-a1b2c3d4' already exists");
      throw e;
    };
    expect(ensureWorktreeSync(REF, exec)).toEqual({ ok: true, created: false });
  });
});
