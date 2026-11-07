import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitHeadCommit } from './git-head';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-head-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('gitHeadCommit', () => {
  it('returns undefined for a non-git folder', async () => {
    expect(await gitHeadCommit(dir)).toBeUndefined();
  });

  it('returns undefined for a missing folder', async () => {
    expect(await gitHeadCommit(path.join(dir, 'nope'))).toBeUndefined();
  });

  it.skipIf(!gitAvailable())('returns undefined for a repo without commits', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    expect(await gitHeadCommit(dir)).toBeUndefined();
  });

  it.skipIf(!gitAvailable())('returns the HEAD sha of a repo with a commit', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'init'],
      { cwd: dir },
    );
    const expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    expect(await gitHeadCommit(dir)).toBe(expected);
  });
});
