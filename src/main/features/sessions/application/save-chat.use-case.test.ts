import { describe, it, expect, vi } from 'vitest';
import { SaveChatUseCase } from './save-chat.use-case';
import type { ProjectRegistry, SessionStore, StateStore } from '../../../shared/ports';
import type { PersistedSession } from '../../../../shared/domain/session';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Fakes ───────────────────────────────────────────────────────────────────

function makeSessionStore(seed: PersistedSession[] = []) {
  const saved: Array<{ project: string; session: PersistedSession }> = [];
  const store = new Map<string, PersistedSession>();
  for (const s of seed) store.set(`${s.project}::${s.id}`, s);
  const sessions: SessionStore = {
    newSessionId: () => 'generated-id',
    isValidSessionId: (id): id is string => typeof id === 'string' && UUID_RE.test(id),
    save: (project, session) => { saved.push({ project, session }); store.set(`${project}::${session.id}`, session); },
    load: (project, id) => store.get(`${project}::${id}`) ?? null,
    list: () => [],
    deleteOne: vi.fn(),
    deleteProjectSessions: vi.fn(),
    collectAllStats: () => [],
  };
  return { sessions, saved };
}

// A registry that explodes if touched — proves `saveAs` never mutates it.
function strictRegistry(): ProjectRegistry {
  const boom = () => { throw new Error('registry must not be touched by saveAs'); };
  return {
    getOrCreate: boom, find: boom, has: () => false, delete: vi.fn(),
    entries: () => [][Symbol.iterator](), values: () => [][Symbol.iterator](),
    paths: () => [], isRunning: () => false, runningCount: () => 0,
    stopProject: vi.fn(), stopAll: () => [], renamePrefix: vi.fn(), deletePrefix: () => [],
  } as unknown as ProjectRegistry;
}

function makeState(): StateStore {
  return { save: vi.fn() } as unknown as StateStore;
}

const BASE = '/workspace/my-project';
const SID = '11111111-2222-3333-4444-555555555555';

describe('SaveChatUseCase.saveAs (T-156)', () => {
  it('persists under the base project with the explicit session id', () => {
    const { sessions, saved } = makeSessionStore();
    const useCase = new SaveChatUseCase({ registry: strictRegistry(), sessions, state: makeState() });

    const result = useCase.saveAs(BASE, SID, [{ id: 'm1', role: 'user', text: 'hi' }]);

    expect(result).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.project).toBe(BASE);
    expect(saved[0]!.session.id).toBe(SID);
    expect(saved[0]!.session.project).toBe(BASE);
    expect(saved[0]!.session.messages).toHaveLength(1);
  });

  it('never touches the project registry (active session stays the primary pane)', () => {
    const { sessions } = makeSessionStore();
    const useCase = new SaveChatUseCase({ registry: strictRegistry(), sessions, state: makeState() });
    expect(() => useCase.saveAs(BASE, SID, [])).not.toThrow();
  });

  it('preserves the original createdAt across saves', () => {
    const existing: PersistedSession = {
      id: SID, project: BASE, createdAt: 1000, updatedAt: 2000, messages: [],
    };
    const { sessions, saved } = makeSessionStore([existing]);
    const useCase = new SaveChatUseCase({ registry: strictRegistry(), sessions, state: makeState() });

    useCase.saveAs(BASE, SID, [{ id: 'm1', role: 'user', text: 'again' }]);

    expect(saved[0]!.session.createdAt).toBe(1000);
    expect(saved[0]!.session.updatedAt).toBeGreaterThan(2000 - 1);
  });

  it('rejects an invalid (non-UUID) session id without writing', () => {
    const { sessions, saved } = makeSessionStore();
    const useCase = new SaveChatUseCase({ registry: strictRegistry(), sessions, state: makeState() });

    const result = useCase.saveAs(BASE, 'not-a-uuid', [{ id: 'm1', role: 'user', text: 'x' }]);

    expect(result).toBe(true);
    expect(saved).toHaveLength(0);
  });
});

// ── Identity stamping (S-2 F0.1) ─────────────────────────────────────────────

function makeRegistry(activeSessionId: string | null = SID): ProjectRegistry {
  const record = { activeSessionId } as { activeSessionId: string | null };
  return {
    getOrCreate: () => record,
    isRunning: () => false,
  } as unknown as ProjectRegistry;
}

const ASSISTANT_WITH_IDENTITY = {
  id: 'a1',
  role: 'assistant',
  agentId: 'claude',
  events: [{ kind: 'session_started', agentSessionId: 'native-42' }],
};

describe('SaveChatUseCase — session identity (S-2 F0.1)', () => {
  it('execute stamps agentId + agentSessionId extracted from the transcript', () => {
    const { sessions, saved } = makeSessionStore();
    const useCase = new SaveChatUseCase({ registry: makeRegistry(), sessions, state: makeState() });

    useCase.execute(BASE, [{ id: 'u1', role: 'user', text: 'hola' }, ASSISTANT_WITH_IDENTITY]);

    expect(saved[0]!.session.agentId).toBe('claude');
    expect(saved[0]!.session.agentSessionId).toBe('native-42');
  });

  it('execute preserves the previously stored identity when new messages carry none', () => {
    const existing: PersistedSession = {
      id: SID, project: BASE, createdAt: 1, updatedAt: 2, messages: [],
      agentId: 'codex', agentSessionId: 'native-old',
    };
    const { sessions, saved } = makeSessionStore([existing]);
    const useCase = new SaveChatUseCase({ registry: makeRegistry(), sessions, state: makeState() });

    useCase.execute(BASE, [{ id: 'u1', role: 'user', text: 'sin run todavía' }]);

    expect(saved[0]!.session.agentId).toBe('codex');
    expect(saved[0]!.session.agentSessionId).toBe('native-old');
  });

  it('execute omits identity entirely when neither transcript nor store know it', () => {
    const { sessions, saved } = makeSessionStore();
    const useCase = new SaveChatUseCase({ registry: makeRegistry(), sessions, state: makeState() });

    useCase.execute(BASE, [{ id: 'u1', role: 'user', text: 'hola' }]);

    expect('agentId' in saved[0]!.session).toBe(false);
    expect('agentSessionId' in saved[0]!.session).toBe(false);
  });

  it('saveAs stamps workdir/branch and preserves them when later saves omit them (S-3 F2.1)', () => {
    const { sessions, saved } = makeSessionStore();
    const useCase = new SaveChatUseCase({ registry: strictRegistry(), sessions, state: makeState() });

    useCase.saveAs(BASE, SID, [{ id: 'u1', role: 'user', text: 'x' }], undefined, '/wt/p/s1', 'devia/session-abc');
    expect(saved[0]!.session.workdir).toBe('/wt/p/s1');
    expect(saved[0]!.session.worktreeBranch).toBe('devia/session-abc');

    useCase.saveAs(BASE, SID, [{ id: 'u2', role: 'user', text: 'y' }]);
    expect(saved[1]!.session.workdir).toBe('/wt/p/s1');
    expect(saved[1]!.session.worktreeBranch).toBe('devia/session-abc');
  });

  it('execute never stamps a workdir but preserves a persisted one (S-3 F2.1)', () => {
    const existing: PersistedSession = {
      id: SID, project: BASE, createdAt: 1, updatedAt: 2, messages: [],
      workdir: '/wt/p/s1', worktreeBranch: 'devia/session-abc',
    };
    const { sessions, saved } = makeSessionStore([existing]);
    const useCase = new SaveChatUseCase({ registry: makeRegistry(), sessions, state: makeState() });

    useCase.execute(BASE, [{ id: 'u1', role: 'user', text: 'hola' }]);

    expect(saved[0]!.session.workdir).toBe('/wt/p/s1');
    expect(saved[0]!.session.worktreeBranch).toBe('devia/session-abc');
  });

  it('saveAs stamps and preserves identity the same way', () => {
    const existing: PersistedSession = {
      id: SID, project: BASE, createdAt: 1, updatedAt: 2, messages: [],
      agentId: 'gemini', agentSessionId: 'native-g',
    };
    const { sessions, saved } = makeSessionStore([existing]);
    const useCase = new SaveChatUseCase({ registry: strictRegistry(), sessions, state: makeState() });

    useCase.saveAs(BASE, SID, [{ id: 'u1', role: 'user', text: 'x' }]);
    expect(saved[0]!.session.agentId).toBe('gemini');
    expect(saved[0]!.session.agentSessionId).toBe('native-g');

    useCase.saveAs(BASE, SID, [ASSISTANT_WITH_IDENTITY]);
    expect(saved[1]!.session.agentId).toBe('claude');
    expect(saved[1]!.session.agentSessionId).toBe('native-42');
  });
});
