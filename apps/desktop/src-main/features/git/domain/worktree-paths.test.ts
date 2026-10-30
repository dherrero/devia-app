import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { projectKey } from '../../../shared/project-key';
import { worktreeDir, branchForSession } from './worktree-paths';
import { worktreeRefFor } from './worktree-ref';

const DEVIA = '/home/u/.devia-app';
const SID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';

describe('projectKey', () => {
  it('replaces /, \\ and : with - and strips the leading dash', () => {
    expect(projectKey('/home/u/repos/myApp')).toBe('home-u-repos-myApp');
    expect(projectKey('C:\\Users\\u\\myApp')).toBe('C--Users-u-myApp');
  });

  it('is deterministic', () => {
    expect(projectKey('/a/b')).toBe(projectKey('/a/b'));
  });
});

describe('worktreeDir', () => {
  it('builds <deviaDir>/worktrees/<projectKey>/<sessionId>', () => {
    expect(worktreeDir(DEVIA, '/home/u/repos/myApp', SID)).toBe(
      path.join(DEVIA, 'worktrees', 'home-u-repos-myApp', SID),
    );
  });

  it('is deterministic for the same inputs', () => {
    expect(worktreeDir(DEVIA, '/a/b', SID)).toBe(worktreeDir(DEVIA, '/a/b', SID));
  });
});

describe('branchForSession', () => {
  it('uses the first 8 chars of the session id under the devia/ namespace', () => {
    expect(branchForSession(SID)).toBe('devia/session-a1b2c3d4');
  });
});

describe('worktreeRefFor', () => {
  it('fills worktreeDir + branch from the helpers and keeps inputs', () => {
    const ref = worktreeRefFor(DEVIA, '/home/u/repos/myApp', SID);
    expect(ref).toEqual({
      baseProject: '/home/u/repos/myApp',
      sessionId: SID,
      worktreeDir: path.join(DEVIA, 'worktrees', 'home-u-repos-myApp', SID),
      branch: 'devia/session-a1b2c3d4',
    });
  });

  it('is reproducible', () => {
    expect(worktreeRefFor(DEVIA, '/a/b', SID)).toEqual(worktreeRefFor(DEVIA, '/a/b', SID));
  });
});
