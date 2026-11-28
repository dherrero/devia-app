import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { integrateWorker } from './integrate-worker';
import { createGitRunner } from '../infrastructure/git-runner';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('integrateWorker (real git)', () => {
  let root: string;
  let repo: string;
  let worktree: string;
  const branch = 'devia/session-aaaa1111';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-integrate-'));
    repo = path.join(root, 'repo');
    worktree = path.join(root, 'wt');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'main');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const workerCommit = (file = 'b.txt', content = 'two\n'): string => {
    fs.writeFileSync(path.join(worktree, file), content);
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-q', '-m', `worker ${file}`);
    return git(worktree, 'rev-parse', '--short', 'HEAD');
  };
  const input = () => ({ controllerCwd: repo, branch, worktreeDir: worktree, baseProject: repo });
  const deps = () => ({ git: createGitRunner() });

  it('fast-forwards the controller branch, returns the commits and cleans the worktree and branch', async () => {
    const sha = workerCommit();
    const r = await integrateWorker(deps(), input());
    expect(r).toEqual({ ok: true, commits: [sha] });
    expect(git(repo, 'rev-parse', '--short', 'HEAD')).toBe(sha);
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(true);
    expect(fs.existsSync(worktree)).toBe(false);
    expect(git(repo, 'branch', '--list', branch)).toBe('');
  });

  it('returns not_ff and changes nothing when the controller branch moved on', async () => {
    workerCommit();
    fs.writeFileSync(path.join(repo, 'c.txt'), 'other\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'controller moved');
    const before = git(repo, 'rev-parse', 'HEAD');

    const r = await integrateWorker(deps(), input());
    expect(r).toMatchObject({ ok: false, reason: 'not_ff' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    // The work is not lost: branch and worktree survive.
    expect(fs.existsSync(worktree)).toBe(true);
    expect(git(repo, 'branch', '--list', branch)).toContain(branch);
  });

  it('returns dirty when uncommitted changes of the controller would be overwritten', async () => {
    workerCommit('a.txt', 'worker version\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'uncommitted local edit\n');
    const before = git(repo, 'rev-parse', 'HEAD');

    const r = await integrateWorker(deps(), input());
    expect(r).toMatchObject({ ok: false, reason: 'dirty' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('uncommitted local edit\n');
    expect(fs.existsSync(worktree)).toBe(true);
  });

  it('succeeds with no commits when the worker changed nothing, and still cleans up', async () => {
    const r = await integrateWorker(deps(), input());
    expect(r).toEqual({ ok: true, commits: [] });
    expect(fs.existsSync(worktree)).toBe(false);
  });

  it('reports git_error for a branch that does not exist, without throwing', async () => {
    const r = await integrateWorker(deps(), { ...input(), branch: 'devia/session-nope0000' });
    expect(r).toMatchObject({ ok: false, reason: 'git_error' });
  });
});
