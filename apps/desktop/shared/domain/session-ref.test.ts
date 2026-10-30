import { describe, it, expect } from 'vitest';
import { sessionKey, primarySessionRef, type SessionRef } from './session-ref';

const PROJECT = '/home/user/repos/myapp';
const WORKTREE = '/home/user/repos/myapp-session-2';

describe('primarySessionRef', () => {
  it('sets workdir equal to baseProject', () => {
    const ref = primarySessionRef(PROJECT, 'sess-1');
    expect(ref.workdir).toBe(PROJECT);
    expect(ref.baseProject).toBe(PROJECT);
    expect(ref.sessionId).toBe('sess-1');
  });

  it('omits branch (exactOptionalPropertyTypes-safe)', () => {
    const ref = primarySessionRef(PROJECT, 'sess-1');
    expect('branch' in ref).toBe(false);
  });
});

describe('sessionKey — single-pane invariant', () => {
  it('returns the project path for the primary session (unchanged behaviour)', () => {
    const ref = primarySessionRef(PROJECT, 'sess-1');
    expect(sessionKey(ref)).toBe(PROJECT);
  });

  it('is identical to the bare project path so existing maps stay valid', () => {
    const ref = primarySessionRef(PROJECT, 'sess-1');
    const existingMapKey = PROJECT;
    expect(sessionKey(ref)).toBe(existingMapKey);
  });
});

describe('sessionKey — additional sessions', () => {
  it('returns the worktree dir for an additional session', () => {
    const ref: SessionRef = {
      baseProject: PROJECT,
      sessionId: 'sess-2',
      workdir: WORKTREE,
      branch: 'feat/s-13-session-2',
    };
    expect(sessionKey(ref)).toBe(WORKTREE);
  });

  it('two sessions with different workdirs produce different keys', () => {
    const ref1 = primarySessionRef(PROJECT, 'sess-1');
    const ref2: SessionRef = {
      baseProject: PROJECT,
      sessionId: 'sess-2',
      workdir: WORKTREE,
      branch: 'feat/s-13-session-2',
    };
    expect(sessionKey(ref1)).not.toBe(sessionKey(ref2));
  });

  it('two refs with the same workdir produce the same key', () => {
    const a: SessionRef = { baseProject: PROJECT, sessionId: 'sess-a', workdir: WORKTREE };
    const b: SessionRef = { baseProject: PROJECT, sessionId: 'sess-b', workdir: WORKTREE };
    expect(sessionKey(a)).toBe(sessionKey(b));
  });
});

describe('sessionKey — determinism', () => {
  it('is pure: same input always returns the same key', () => {
    const ref = primarySessionRef(PROJECT, 'sess-1');
    expect(sessionKey(ref)).toBe(sessionKey(ref));
  });
});
