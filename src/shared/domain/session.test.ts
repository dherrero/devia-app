import { describe, it, expect } from 'vitest';
import { extractSessionIdentity, parsePersistedSession } from './session';

const BASE = { id: 'sess-1', project: '/p', createdAt: 1, updatedAt: 2, messages: [] };

describe('parsePersistedSession — stats handling (S-7)', () => {
  it('returns null when core fields are missing (stats does not rescue it)', () => {
    expect(parsePersistedSession({ stats: { agentId: 'claude', costUsd: 0, turnCount: 0, updatedAt: 1 } })).toBeNull();
  });

  it('parses a session with no stats and leaves the field absent', () => {
    const parsed = parsePersistedSession({ ...BASE });
    expect(parsed).not.toBeNull();
    expect('stats' in (parsed as object)).toBe(false);
  });

  it('keeps a valid normalised rollup', () => {
    const parsed = parsePersistedSession({
      ...BASE,
      stats: { agentId: 'claude', model: 'claude-opus-4-8', costUsd: 0.3, turnCount: 1, updatedAt: 9, compactions: [] },
    });
    expect(parsed?.stats?.costUsd).toBe(0.3);
    expect(parsed?.stats?.model).toBe('claude-opus-4-8');
  });

  it('drops a malformed rollup but keeps the session', () => {
    const parsed = parsePersistedSession({ ...BASE, stats: { not: 'a valid rollup' } });
    expect(parsed).not.toBeNull();
    expect(parsed?.stats).toBeUndefined();
  });
});

describe('parsePersistedSession — identity fields (S-2 F0.1)', () => {
  it('keeps valid agentId and agentSessionId', () => {
    const parsed = parsePersistedSession({ ...BASE, agentId: 'claude', agentSessionId: 'native-1' });
    expect(parsed?.agentId).toBe('claude');
    expect(parsed?.agentSessionId).toBe('native-1');
  });

  it('tolerates legacy files without the fields', () => {
    const parsed = parsePersistedSession({ ...BASE });
    expect(parsed).not.toBeNull();
    expect('agentId' in (parsed as object)).toBe(false);
    expect('agentSessionId' in (parsed as object)).toBe(false);
  });

  it('drops wrong-typed or empty identity values without failing the session', () => {
    const parsed = parsePersistedSession({ ...BASE, agentId: 42, agentSessionId: '' });
    expect(parsed).not.toBeNull();
    expect(parsed?.agentId).toBeUndefined();
    expect(parsed?.agentSessionId).toBeUndefined();
  });
});

describe('parsePersistedSession — workdir fields (S-3 F2.1)', () => {
  it('keeps valid workdir and worktreeBranch, drops malformed ones', () => {
    const parsed = parsePersistedSession({ ...BASE, workdir: '/wt/p/s1', worktreeBranch: 'devia/session-abc' });
    expect(parsed?.workdir).toBe('/wt/p/s1');
    expect(parsed?.worktreeBranch).toBe('devia/session-abc');

    const dropped = parsePersistedSession({ ...BASE, workdir: 42, worktreeBranch: '' });
    expect(dropped).not.toBeNull();
    expect(dropped?.workdir).toBeUndefined();
    expect(dropped?.worktreeBranch).toBeUndefined();
  });
});

describe('extractSessionIdentity (S-2 F0.1)', () => {
  const assistant = (over: Record<string, unknown>) => ({ id: 'a', role: 'assistant', ...over });

  it('returns empty identity for an empty transcript', () => {
    expect(extractSessionIdentity([])).toEqual({});
  });

  it('takes agentId from the LAST assistant message that carries one', () => {
    const identity = extractSessionIdentity([
      assistant({ agentId: 'codex' }),
      { id: 'u', role: 'user', text: 'hola' },
      assistant({ agentId: 'claude' }),
      assistant({}),
    ]);
    expect(identity.agentId).toBe('claude');
  });

  it('takes agentSessionId from the last session_started event across assistant events[]', () => {
    const identity = extractSessionIdentity([
      assistant({ events: [{ kind: 'session_started', agentSessionId: 'old' }] }),
      assistant({
        events: [
          { kind: 'text', text: 'hi' },
          { kind: 'session_started', agentSessionId: 'older' },
          { kind: 'session_started', agentSessionId: 'newest' },
        ],
      }),
    ]);
    expect(identity.agentSessionId).toBe('newest');
  });

  it('can source agentId and agentSessionId from different messages', () => {
    const identity = extractSessionIdentity([
      assistant({ events: [{ kind: 'session_started', agentSessionId: 'native-7' }] }),
      assistant({ agentId: 'gemini', events: [] }),
    ]);
    expect(identity).toEqual({ agentId: 'gemini', agentSessionId: 'native-7' });
  });

  it('ignores non-assistant messages and malformed entries', () => {
    const identity = extractSessionIdentity([
      null,
      'garbage',
      { role: 'user', agentId: 'claude', events: [{ kind: 'session_started', agentSessionId: 'x' }] },
      assistant({ agentId: 7, events: [{ kind: 'session_started', agentSessionId: 9 }] }),
    ]);
    expect(identity).toEqual({});
  });
});

describe('parsePersistedSession — runMode', () => {
  it('keeps a valid run mode', () => {
    expect(parsePersistedSession({ ...BASE, runMode: 'apply-yolo' })?.runMode).toBe('apply-yolo');
  });

  it('drops an unknown or mistyped run mode', () => {
    expect('runMode' in (parsePersistedSession({ ...BASE, runMode: 'turbo' }) as object)).toBe(false);
    expect('runMode' in (parsePersistedSession({ ...BASE, runMode: 3 }) as object)).toBe(false);
  });

  it('tolerates sessions written before the field existed', () => {
    expect('runMode' in (parsePersistedSession({ ...BASE }) as object)).toBe(false);
  });
});
