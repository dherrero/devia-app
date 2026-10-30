import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CliGitBrancher, type ExecRunner } from './cli-git-brancher';
import type { ConfigRepository } from '../../../shared/ports';

// existsSync is read to confirm `<cwd>/.git` exists; control it per test.
const fsState = vi.hoisted(() => ({ exists: true }));
vi.mock('node:fs', () => ({ existsSync: () => fsState.exists }));

const WSROOT = '/ws';
const config = { get: () => ({ workspaceRoot: WSROOT }) } as unknown as ConfigRepository;

const NUL = '\x00';
const row = (fields: string[]) => fields.join(NUL);

function makeBrancher(exec: ExecRunner): CliGitBrancher {
  return new CliGitBrancher(config, exec);
}

beforeEach(() => {
  fsState.exists = true;
});

describe('CliGitBrancher.list', () => {
  it('parses local + remote branches and skips refs/remotes/origin/HEAD', async () => {
    const out = [
      row(['refs/heads/dev', 'a1b2c3d', '*', 'origin/dev', '[ahead 2, behind 1]', '1700000000', 'fix bug']),
      row(['refs/heads/main', 'e4f5g6h', '', 'origin/main', '', '1699999999', 'release']),
      row(['refs/remotes/origin/dev', 'a1b2c3d', '', '', '', '1700000000', 'fix bug']),
      row(['refs/remotes/origin/HEAD', 'a1b2c3d', '', '', '', '0', '']),
    ].join('\n');
    const brancher = makeBrancher(() => out);

    const branches = await brancher.list('proj');

    expect(branches).toHaveLength(3);
    expect(branches.some((b) => b.name === 'origin/HEAD')).toBe(false);

    const dev = branches.find((b) => b.name === 'dev')!;
    expect(dev).toMatchObject({
      isRemote: false,
      isCurrent: true,
      upstream: 'origin/dev',
      ahead: 2,
      behind: 1,
      shortSha: 'a1b2c3d',
      subject: 'fix bug',
    });

    const main = branches.find((b) => b.name === 'main')!;
    expect(main.isCurrent).toBe(false);
    expect(main.ahead).toBeUndefined();
    expect(main.behind).toBeUndefined();

    const remoteDev = branches.find((b) => b.name === 'origin/dev')!;
    expect(remoteDev.isRemote).toBe(true);
    expect(remoteDev.upstream).toBeUndefined();
  });

  it('flags a deleted upstream as upstreamGone', async () => {
    const out = row(['refs/heads/old', 'deadbee', '', 'origin/old', '[gone]', '1690000000', 'wip']);
    const branches = await makeBrancher(() => out).list('proj');
    expect(branches[0]!.upstreamGone).toBe(true);
  });

  it('returns [] when the project is not a git repo', async () => {
    fsState.exists = false;
    const branches = await makeBrancher(() => 'whatever').list('proj');
    expect(branches).toEqual([]);
  });

  it('returns [] when git throws', async () => {
    const branches = await makeBrancher(() => {
      throw new Error('not a git repository');
    }).list('proj');
    expect(branches).toEqual([]);
  });
});

describe('CliGitBrancher.checkout', () => {
  it('checks out a local branch with a plain checkout (no force flags)', async () => {
    const calls: string[][] = [];
    const exec: ExecRunner = (args) => {
      calls.push(args);
      return '';
    };
    const result = await makeBrancher(exec).checkout('proj', { name: 'feature/x', isRemote: false });

    expect(calls).toContainEqual(['checkout', 'feature/x']);
    expect(result.ok).toBe(true);
    expect(result.branch).toBe('feature/x');
    const flat = calls.flat();
    expect(flat).not.toContain('--force');
    expect(flat).not.toContain('-f');
    expect(flat).not.toContain('-B');
  });

  it('reuses an existing local tracking branch for a remote ref', async () => {
    const calls: string[][] = [];
    const exec: ExecRunner = (args) => {
      calls.push(args);
      // show-ref --verify succeeds (local branch exists) → returns, does not throw.
      return '';
    };
    const result = await makeBrancher(exec).checkout('proj', { name: 'origin/dev', isRemote: true });

    expect(calls).toContainEqual(['show-ref', '--verify', '--quiet', 'refs/heads/dev']);
    expect(calls).toContainEqual(['checkout', 'dev']);
    expect(calls).not.toContainEqual(['checkout', '--track', 'origin/dev']);
    expect(result.branch).toBe('dev');
  });

  it('creates a tracking branch when no local branch exists for a remote ref', async () => {
    const calls: string[][] = [];
    const exec: ExecRunner = (args) => {
      calls.push(args);
      if (args[0] === 'show-ref') throw new Error('no such ref'); // local branch absent
      return '';
    };
    const result = await makeBrancher(exec).checkout('proj', { name: 'origin/feat', isRemote: true });

    expect(calls).toContainEqual(['checkout', '--track', 'origin/feat']);
    expect(result.ok).toBe(true);
    expect(result.branch).toBe('feat');
  });

  it('surfaces the git error tail on a dirty-tree conflict without retrying with force', async () => {
    const calls: string[][] = [];
    const exec: ExecRunner = (args) => {
      calls.push(args);
      const err = new Error('checkout failed') as Error & { stderr: Buffer };
      err.stderr = Buffer.from('error: Your local changes to the following files would be overwritten by checkout');
      throw err;
    };
    const result = await makeBrancher(exec).checkout('proj', { name: 'other', isRemote: false });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('would be overwritten');
    expect(calls.flat()).not.toContain('--force');
  });
});
