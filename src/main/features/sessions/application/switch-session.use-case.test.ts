import { describe, it, expect, vi } from 'vitest';
import { SwitchSessionUseCase } from './switch-session.use-case';
import type { ProjectRegistry, ProjectRecord, SessionStore, StateStore } from '../../../shared/ports';
import type { PersistedSession } from '../../../../shared/domain/session';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE = '/workspace/my-project';
const SID = '11111111-2222-3333-4444-555555555555';

function makeSessionStore(seed: PersistedSession[] = []) {
  const store = new Map<string, PersistedSession>();
  for (const s of seed) store.set(`${s.project}::${s.id}`, s);
  const sessions = {
    newSessionId: () => 'generated-id',
    isValidSessionId: (id: unknown): id is string => typeof id === 'string' && UUID_RE.test(id),
    save: vi.fn(),
    load: (project: string, id: string) => store.get(`${project}::${id}`) ?? null,
    list: () => [],
    deleteOne: vi.fn(),
    deleteProjectSessions: vi.fn(),
    collectAllStats: () => [],
  } as unknown as SessionStore;
  return sessions;
}

function makeRegistry(running = false) {
  const record: ProjectRecord = {
    name: BASE,
    isRunning: running,
    newSession: true,
    activeSessionId: 'previous-active',
    agentSessionId: 'stale-native-id',
    agentSessionAgentId: 'claude',
  } as ProjectRecord;
  const registry = {
    getOrCreate: () => record,
    find: () => record,
    isRunning: () => running,
  } as unknown as ProjectRegistry;
  return { registry, record };
}

function makeState(): StateStore {
  return { save: vi.fn() } as unknown as StateStore;
}

describe('SwitchSessionUseCase — native conversation restore (S-2 F0.2)', () => {
  it('restores agentSessionId + owner from the stamped session fields', () => {
    const session: PersistedSession = {
      id: SID, project: BASE, createdAt: 1, updatedAt: 2, messages: [{ id: 'u', role: 'user' }],
      agentId: 'codex', agentSessionId: 'native-codex-7',
    };
    const { registry, record } = makeRegistry();
    const useCase = new SwitchSessionUseCase({ registry, sessions: makeSessionStore([session]), state: makeState() });

    const result = useCase.execute(BASE, SID);

    expect(record.activeSessionId).toBe(SID);
    expect(record.agentSessionId).toBe('native-codex-7');
    expect(record.agentSessionAgentId).toBe('codex');
    expect(result.id).toBe(SID);
    expect(result.messages).toHaveLength(1);
  });

  it('falls back to extractSessionIdentity for legacy sessions without stamped fields', () => {
    const session: PersistedSession = {
      id: SID, project: BASE, createdAt: 1, updatedAt: 2,
      messages: [{
        id: 'a1', role: 'assistant', agentId: 'claude',
        events: [{ kind: 'session_started', agentSessionId: 'native-legacy' }],
      }],
    };
    const { registry, record } = makeRegistry();
    const useCase = new SwitchSessionUseCase({ registry, sessions: makeSessionStore([session]), state: makeState() });

    useCase.execute(BASE, SID);

    expect(record.agentSessionId).toBe('native-legacy');
    expect(record.agentSessionAgentId).toBe('claude');
  });

  it('clears the native pointer when the chosen session has no identity at all', () => {
    const session: PersistedSession = {
      id: SID, project: BASE, createdAt: 1, updatedAt: 2,
      messages: [{ id: 'u', role: 'user', text: 'hola' }],
    };
    const { registry, record } = makeRegistry();
    const useCase = new SwitchSessionUseCase({ registry, sessions: makeSessionStore([session]), state: makeState() });

    useCase.execute(BASE, SID);

    expect(record.agentSessionId).toBeNull();
    expect(record.agentSessionAgentId).toBeNull();
  });

  it('a stamped agentId without native id still records the owner and nulls the session pointer', () => {
    const session: PersistedSession = {
      id: SID, project: BASE, createdAt: 1, updatedAt: 2, messages: [],
      agentId: 'gemini',
    };
    const { registry, record } = makeRegistry();
    const useCase = new SwitchSessionUseCase({ registry, sessions: makeSessionStore([session]), state: makeState() });

    useCase.execute(BASE, SID);

    expect(record.agentSessionId).toBeNull();
    expect(record.agentSessionAgentId).toBe('gemini');
  });

  it('persists the registry change via state.save()', () => {
    const session: PersistedSession = { id: SID, project: BASE, createdAt: 1, updatedAt: 2, messages: [] };
    const { registry } = makeRegistry();
    const state = makeState();
    const useCase = new SwitchSessionUseCase({ registry, sessions: makeSessionStore([session]), state });

    useCase.execute(BASE, SID);

    expect(state.save).toHaveBeenCalled();
  });

  it('keeps the existing return contract (stats ride along when present)', () => {
    const session: PersistedSession = {
      id: SID, project: BASE, createdAt: 1, updatedAt: 2, messages: [],
      stats: { agentId: 'claude', costUsd: 0.5, turnCount: 2, updatedAt: 9, compactions: [] },
    };
    const { registry } = makeRegistry();
    const useCase = new SwitchSessionUseCase({ registry, sessions: makeSessionStore([session]), state: makeState() });

    const result = useCase.execute(BASE, SID);

    expect(result.stats?.costUsd).toBe(0.5);
  });
});

describe('SwitchSessionUseCase — hard guards (S-2 F0.4)', () => {
  const session: PersistedSession = {
    id: SID, project: BASE, createdAt: 1, updatedAt: 2, messages: [],
    agentId: 'codex', agentSessionId: 'native-7',
  };

  it('throws SESSION_BUSY and mutates nothing while a run is active', () => {
    const { registry, record } = makeRegistry(true);
    const state = makeState();
    const useCase = new SwitchSessionUseCase({ registry, sessions: makeSessionStore([session]), state });

    expect(() => useCase.execute(BASE, SID)).toThrowError('SESSION_BUSY');
    expect(record.activeSessionId).toBe('previous-active');
    expect(record.agentSessionId).toBe('stale-native-id');
    expect(state.save).not.toHaveBeenCalled();
  });

  it('throws SESSION_QUEUE_PENDING when parked items exist for the identity', () => {
    const { registry, record } = makeRegistry(false);
    const useCase = new SwitchSessionUseCase({
      registry,
      sessions: makeSessionStore([session]),
      state: makeState(),
      queue: { pendingCount: () => 2 },
    });

    expect(() => useCase.execute(BASE, SID)).toThrowError('SESSION_QUEUE_PENDING');
    expect(record.activeSessionId).toBe('previous-active');
  });

  it('idle + empty queue → switch proceeds exactly as before', () => {
    const { registry, record } = makeRegistry(false);
    const useCase = new SwitchSessionUseCase({
      registry,
      sessions: makeSessionStore([session]),
      state: makeState(),
      queue: { pendingCount: () => 0 },
    });

    const result = useCase.execute(BASE, SID);

    expect(result.id).toBe(SID);
    expect(record.activeSessionId).toBe(SID);
    expect(record.agentSessionAgentId).toBe('codex');
  });
});

describe('SwitchSessionUseCase — handoff precompute trigger (S-2 F2.3)', () => {
  it('notifies prepareHandoff with identity, session, messages and owner', () => {
    const session: PersistedSession = {
      id: SID, project: BASE, createdAt: 1, updatedAt: 2,
      messages: [{ id: 'u', role: 'user', text: 'hola' }],
      agentId: 'codex', agentSessionId: 'native-7',
    };
    const calls: unknown[][] = [];
    const { registry } = makeRegistry();
    const useCase = new SwitchSessionUseCase({
      registry,
      sessions: makeSessionStore([session]),
      state: makeState(),
      prepareHandoff: (...args) => calls.push(args),
    });

    useCase.execute(BASE, SID);

    expect(calls).toEqual([[BASE, SID, [{ id: 'u', role: 'user', text: 'hola' }], 'codex']]);
  });

  it('a throwing prepareHandoff never breaks the switch', () => {
    const session: PersistedSession = { id: SID, project: BASE, createdAt: 1, updatedAt: 2, messages: [] };
    const { registry } = makeRegistry();
    const useCase = new SwitchSessionUseCase({
      registry,
      sessions: makeSessionStore([session]),
      state: makeState(),
      prepareHandoff: () => { throw new Error('boom'); },
    });

    expect(() => useCase.execute(BASE, SID)).not.toThrow();
  });
});
