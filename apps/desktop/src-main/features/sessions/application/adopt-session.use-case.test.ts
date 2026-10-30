import { describe, it, expect, vi } from 'vitest';
import { AdoptSessionUseCase } from './adopt-session.use-case';
import type { ProjectRegistry, ProjectRecord, SessionStore, StateStore } from '../../../shared/ports';
import type { PersistedSession } from '../../../../shared/domain/session';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE = '/workspace/my-project';
const RUN_KEY = '11111111-2222-3333-4444-555555555555';
const SID = RUN_KEY;

function freshRecord(name: string): ProjectRecord {
  return {
    name,
    isRunning: false,
    newSession: true,
    activeSessionId: null,
    agentSessionId: null,
    agentSessionAgentId: null,
  } as ProjectRecord;
}

function build(opts: {
  running?: string[];
  pending?: number;
  sessions?: PersistedSession[];
  live?: string[];
  recreateTo?: string | null;
} = {}) {
  const records = new Map<string, ProjectRecord>();
  records.set(BASE, { ...freshRecord(BASE), activeSessionId: 'primary-active', agentSessionId: 'primary-native', agentSessionAgentId: 'claude' });
  const registry = {
    getOrCreate: (key: string) => {
      const existing = records.get(key);
      if (existing) return existing;
      const created = freshRecord(key);
      records.set(key, created);
      return created;
    },
    isRunning: (key: string) => (opts.running ?? []).includes(key),
  } as unknown as ProjectRegistry;

  const store = new Map<string, PersistedSession>();
  for (const s of opts.sessions ?? []) store.set(`${s.project}::${s.id}`, s);
  const sessions = {
    isValidSessionId: (id: unknown): id is string => typeof id === 'string' && UUID_RE.test(id),
    load: (project: string, id: string) => store.get(`${project}::${id}`) ?? null,
  } as unknown as SessionStore;

  const state = { save: vi.fn() } as unknown as StateStore;
  const recreate = vi.fn(() => opts.recreateTo ?? null);
  const useCase = new AdoptSessionUseCase({
    registry, sessions, state,
    queue: { pendingCount: () => opts.pending ?? 0 },
    worktrees: {
      isLive: (workdir: string) => (opts.live ?? []).includes(workdir),
      recreate,
    },
  });
  return { useCase, records, state, recreate };
}

const SEEDED: PersistedSession = {
  id: SID, project: BASE, createdAt: 1, updatedAt: 2,
  messages: [{ id: 'u', role: 'user', text: 'hola' }],
  agentId: 'claude', agentSessionId: 'native-claude-9',
};

describe('AdoptSessionUseCase (S-2 F5.1)', () => {
  it('adopts the session under the pane identity and restores the native conversation', () => {
    const { useCase, records, state } = build({ sessions: [SEEDED] });

    const result = useCase.execute(BASE, RUN_KEY, SID);

    const pane = records.get(RUN_KEY)!;
    expect(pane.activeSessionId).toBe(SID);
    expect(pane.newSession).toBe(false);
    expect(pane.agentSessionId).toBe('native-claude-9');
    expect(pane.agentSessionAgentId).toBe('claude');
    expect(state.save).toHaveBeenCalled();
    expect(result).toMatchObject({ id: SID, messages: [{ id: 'u', role: 'user', text: 'hola' }] });
  });

  it('never touches the base project record', () => {
    const { useCase, records } = build({ sessions: [SEEDED] });

    useCase.execute(BASE, RUN_KEY, SID);

    const primary = records.get(BASE)!;
    expect(primary.activeSessionId).toBe('primary-active');
    expect(primary.agentSessionId).toBe('primary-native');
  });

  it('falls back to extractSessionIdentity for legacy sessions', () => {
    const legacy: PersistedSession = {
      id: SID, project: BASE, createdAt: 1, updatedAt: 2,
      messages: [{
        id: 'a', role: 'assistant', agentId: 'codex',
        events: [{ kind: 'session_started', agentSessionId: 'native-legacy' }],
      }],
    };
    const { useCase, records } = build({ sessions: [legacy] });

    useCase.execute(BASE, RUN_KEY, SID);

    const pane = records.get(RUN_KEY)!;
    expect(pane.agentSessionId).toBe('native-legacy');
    expect(pane.agentSessionAgentId).toBe('codex');
  });

  it('throws SESSION_BUSY while the pane identity runs', () => {
    const { useCase, records } = build({ sessions: [SEEDED], running: [RUN_KEY] });

    expect(() => useCase.execute(BASE, RUN_KEY, SID)).toThrowError('SESSION_BUSY');
    expect(records.has(RUN_KEY)).toBe(false);
  });

  it('throws SESSION_QUEUE_PENDING when the pane has parked items', () => {
    const { useCase } = build({ sessions: [SEEDED], pending: 1 });
    expect(() => useCase.execute(BASE, RUN_KEY, SID)).toThrowError('SESSION_QUEUE_PENDING');
  });

  it('rejects an unknown session with a clear error', () => {
    const { useCase } = build();
    expect(() => useCase.execute(BASE, RUN_KEY, SID)).toThrowError('La sesión no existe');
  });

  it('rejects an invalid session id', () => {
    const { useCase } = build({ sessions: [SEEDED] });
    expect(() => useCase.execute(BASE, RUN_KEY, 'nope')).toThrowError('UUID');
  });
});

describe('AdoptSessionUseCase — worktree recovery chain (S-3 F2.2)', () => {
  const WT = '/devia/worktrees/p/s1';
  const ISOLATED: PersistedSession = {
    ...SEEDED, workdir: WT, worktreeBranch: 'devia/session-1111',
  };

  it('a LIVE persisted worktree is reattached (resume + files intact)', () => {
    const { useCase, recreate } = build({ sessions: [ISOLATED], live: [WT] });

    const result = useCase.execute(BASE, RUN_KEY, SID);

    expect(result.workdir).toBe(WT);
    expect(result.branch).toBe('devia/session-1111');
    expect(result.isolation).toBe('worktree');
    expect(recreate).not.toHaveBeenCalled();
  });

  it('a swept worktree with a surviving branch is RECREATED from it', () => {
    const { useCase, recreate } = build({ sessions: [ISOLATED], recreateTo: WT });

    const result = useCase.execute(BASE, RUN_KEY, SID);

    expect(recreate).toHaveBeenCalledWith(BASE, SID, 'devia/session-1111');
    expect(result.workdir).toBe(WT);
    expect(result.isolation).toBe('recreated');
  });

  it('nothing recoverable → base checkout flagged isolation none', () => {
    const { useCase } = build({ sessions: [ISOLATED], recreateTo: null });

    const result = useCase.execute(BASE, RUN_KEY, SID);

    expect(result.workdir).toBe(BASE);
    expect(result.isolation).toBe('none');
    expect('branch' in result).toBe(false);
  });

  it('sessions without persisted workdir keep the pre-S-3 base behaviour', () => {
    const { useCase, recreate } = build({ sessions: [SEEDED] });

    const result = useCase.execute(BASE, RUN_KEY, SID);

    expect(result.workdir).toBe(BASE);
    expect(result.isolation).toBe('none');
    expect(recreate).not.toHaveBeenCalled();
  });

  it('a stale workdir outside the managed root reads as not-live → never reattached', () => {
    const outside: PersistedSession = { ...SEEDED, workdir: '/etc', worktreeBranch: 'devia/session-1111' };
    const { useCase } = build({ sessions: [outside], recreateTo: null });

    const result = useCase.execute(BASE, RUN_KEY, SID);

    expect(result.workdir).toBe(BASE);
    expect(result.isolation).toBe('none');
  });
});
