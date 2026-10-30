import { describe, it, expect } from 'vitest';
import { SaveChatUseCase } from './save-chat.use-case';
import { SwitchSessionUseCase } from './switch-session.use-case';
import { ListSessionsUseCase } from './list-sessions.use-case';
import { LoadActiveStatsUseCase } from './load-active-stats.use-case';
import { AggregateStatsUseCase } from './aggregate-stats.use-case';
import type { ProjectRegistry, ProjectRecord, SessionStore, StateStore } from '../../../shared/ports';
import type { PersistedSession } from '../../../../shared/domain/session';
import type { SessionStats } from '../../../../shared/domain/session-stats';

const PROJECT = '/workspace/p';

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    agentId: 'claude',
    model: 'claude-opus-4-8',
    contextWindow: 1_000_000,
    contextTokens: 50_000,
    costUsd: 0.42,
    turnCount: 2,
    compactions: [],
    updatedAt: 100,
    ...overrides,
  };
}

/** In-memory SessionStore that records saves and serves loads/lists. */
function makeStore(seed: PersistedSession[] = []) {
  const map = new Map<string, PersistedSession>(seed.map((s) => [s.id, s]));
  const store: SessionStore = {
    newSessionId: () => 'generated-id',
    isValidSessionId: (id): id is string => typeof id === 'string' && id.length > 0,
    save: (_p, session) => { map.set(session.id, session); },
    load: (_p, id) => map.get(id) ?? null,
    list: () => [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    deleteOne: () => { /* unused */ },
    deleteProjectSessions: () => { /* unused */ },
    collectAllStats: () => [...map.values()].map((s) => s.stats).filter((s): s is NonNullable<typeof s> => !!s),
  };
  return { store, map };
}

function makeRegistry(records: Record<string, Partial<ProjectRecord>>): ProjectRegistry {
  const entries = new Map<string, ProjectRecord>(
    Object.entries(records).map(([name, r]) => [
      name,
      { name, isRunning: false, newSession: false, activeSessionId: null, ...r } as ProjectRecord,
    ]),
  );
  return {
    entries: () => entries.entries() as IterableIterator<readonly [string, ProjectRecord]>,
    getOrCreate: (name) => {
      let rec = entries.get(name);
      if (!rec) { rec = { name, isRunning: false, newSession: false, activeSessionId: null } as ProjectRecord; entries.set(name, rec); }
      return rec;
    },
    find: (name) => entries.get(name),
    has: (name) => entries.has(name),
    delete: () => { /* test stub */ },
    values: () => entries.values(),
    paths: () => [...entries.keys()],
    isRunning: () => false,
    runningCount: () => 0,
    stopProject: () => { /* test stub */ },
    stopAll: () => [],
    renamePrefix: () => { /* test stub */ },
    deletePrefix: () => [],
  };
}

const noopState: StateStore = { save: () => { /* test stub */ } } as unknown as StateStore;

describe('SaveChatUseCase — stats passthrough (S-7 T-80)', () => {
  it('persists the provided rollup', () => {
    const { store, map } = makeStore();
    const registry = makeRegistry({ [PROJECT]: { activeSessionId: 'sess-1' } });
    new SaveChatUseCase({ registry, sessions: store, state: noopState })
      .execute(PROJECT, [{ role: 'user', text: 'hi' }], makeStats({ costUsd: 0.9 }));
    expect(map.get('sess-1')?.stats?.costUsd).toBe(0.9);
  });

  it('preserves the existing rollup when a save omits stats', () => {
    const seeded: PersistedSession = {
      id: 'sess-1', project: PROJECT, createdAt: 1, updatedAt: 1,
      messages: [], stats: makeStats({ costUsd: 0.5 }),
    };
    const { store, map } = makeStore([seeded]);
    const registry = makeRegistry({ [PROJECT]: { activeSessionId: 'sess-1' } });
    new SaveChatUseCase({ registry, sessions: store, state: noopState })
      .execute(PROJECT, [{ role: 'user', text: 'again' }]);
    expect(map.get('sess-1')?.stats?.costUsd).toBe(0.5);
  });

  it('backfills a derived rollup when a save omits stats and none was stored (T-85)', () => {
    const { store, map } = makeStore();
    const registry = makeRegistry({ [PROJECT]: { activeSessionId: 'sess-1' } });
    new SaveChatUseCase({ registry, sessions: store, state: noopState })
      .execute(PROJECT, [
        { role: 'assistant', model: 'claude-x', usage: { inputTokens: 1_000, costUsd: 0.3 } },
      ]);
    expect(map.get('sess-1')?.stats?.costUsd).toBe(0.3);
    expect(map.get('sess-1')?.stats?.contextTokens).toBe(1_000);
  });
});

describe('SwitchSessionUseCase — returns stats (S-7 T-80)', () => {
  it('rides the stored rollup along with the messages', () => {
    const seeded: PersistedSession = {
      id: '11111111-1111-1111-1111-111111111111', project: PROJECT,
      createdAt: 1, updatedAt: 1, messages: [{ role: 'user' }], stats: makeStats(),
    };
    const { store } = makeStore([seeded]);
    const registry = makeRegistry({ [PROJECT]: {} });
    const result = new SwitchSessionUseCase({ registry, sessions: store, state: noopState })
      .execute(PROJECT, seeded.id);
    expect(result.stats?.costUsd).toBe(0.42);
    expect(result.messages).toHaveLength(1);
  });

  it('omits stats when the session has none', () => {
    const seeded: PersistedSession = {
      id: '22222222-2222-2222-2222-222222222222', project: PROJECT,
      createdAt: 1, updatedAt: 1, messages: [],
    };
    const { store } = makeStore([seeded]);
    const registry = makeRegistry({ [PROJECT]: {} });
    const result = new SwitchSessionUseCase({ registry, sessions: store, state: noopState })
      .execute(PROJECT, seeded.id);
    expect(result.stats).toBeUndefined();
  });
});

describe('ListSessionsUseCase — stats summary (S-7 T-80)', () => {
  it('includes the compact stats summary in SessionMeta', () => {
    const seeded: PersistedSession = {
      id: 'sess-1', project: PROJECT, createdAt: 1, updatedAt: 2,
      messages: [{ role: 'user', text: 'hello' }], stats: makeStats(),
    };
    const { store } = makeStore([seeded]);
    const registry = makeRegistry({ [PROJECT]: { activeSessionId: 'sess-1' } });
    const [meta] = new ListSessionsUseCase({ registry, sessions: store }).execute(PROJECT);
    expect(meta?.stats).toEqual({
      model: 'claude-opus-4-8',
      contextWindow: 1_000_000,
      contextTokens: 50_000,
      costUsd: 0.42,
    });
    expect(meta?.isActive).toBe(true);
  });

  it('omits the summary for sessions without stats', () => {
    const seeded: PersistedSession = {
      id: 'sess-2', project: PROJECT, createdAt: 1, updatedAt: 1, messages: [],
    };
    const { store } = makeStore([seeded]);
    const registry = makeRegistry({ [PROJECT]: {} });
    const [meta] = new ListSessionsUseCase({ registry, sessions: store }).execute(PROJECT);
    expect(meta?.stats).toBeUndefined();
  });
});

describe('LoadActiveStatsUseCase (S-7 T-80 / T-85)', () => {
  it('returns the active session rollup keyed by project', () => {
    const seeded: PersistedSession = {
      id: 'sess-1', project: PROJECT, createdAt: 1, updatedAt: 1, messages: [], stats: makeStats(),
    };
    const { store } = makeStore([seeded]);
    const registry = makeRegistry({ [PROJECT]: { activeSessionId: 'sess-1' } });
    const result = new LoadActiveStatsUseCase({ registry, sessions: store }).execute();
    expect(result[PROJECT]?.costUsd).toBe(0.42);
  });

  it('derives a rollup (best-effort) for an active session that stored none (T-85)', () => {
    const noStats: PersistedSession = {
      id: 'sess-1', project: PROJECT, createdAt: 1, updatedAt: 7, messages: [
        { role: 'assistant', model: 'claude-x', usage: { inputTokens: 2_000, costUsd: 0.15 } },
      ],
    };
    const { store } = makeStore([noStats]);
    const registry = makeRegistry({ [PROJECT]: { activeSessionId: 'sess-1' } });
    const result = new LoadActiveStatsUseCase({ registry, sessions: store }).execute();
    expect(result[PROJECT]?.costUsd).toBe(0.15);
    expect(result[PROJECT]?.contextTokens).toBe(2_000);
  });

  it('omits projects with no active session or an empty session', () => {
    const empty: PersistedSession = {
      id: 'sess-1', project: PROJECT, createdAt: 1, updatedAt: 1, messages: [],
    };
    const { store } = makeStore([empty]);
    const registry = makeRegistry({
      [PROJECT]: { activeSessionId: 'sess-1' },     // active but empty → no derivation
      '/workspace/q': { activeSessionId: null },    // no active session
    });
    const result = new LoadActiveStatsUseCase({ registry, sessions: store }).execute();
    expect(result).toEqual({});
  });
});

describe('AggregateStatsUseCase (S-7 T-84)', () => {
  it('sums every session rollup the store exposes', () => {
    const sessions = [
      { id: 's1', project: PROJECT, createdAt: 1, updatedAt: 1, messages: [], stats: makeStats({ model: 'claude-opus-4-8', costUsd: 0.5 }) },
      { id: 's2', project: PROJECT, createdAt: 1, updatedAt: 1, messages: [], stats: makeStats({ model: 'gpt-5', costUsd: 0.2 }) },
    ] as PersistedSession[];
    const { store } = makeStore(sessions);
    const agg = new AggregateStatsUseCase({ sessions: store }).execute();
    expect(agg.grandTotalCostUsd).toBe(0.7);
    expect(agg.byModel).toEqual({ 'claude-opus-4-8': 0.5, 'gpt-5': 0.2 });
    expect(agg.sessionCount).toBe(2);
  });
});

describe('ListSessionsUseCase — agent identity (S-2 F1.2)', () => {
  it('exposes the stamped agentId on SessionMeta and omits it when absent', () => {
    const withAgent: PersistedSession = {
      id: 'sess-a', project: PROJECT, createdAt: 1, updatedAt: 2,
      messages: [], agentId: 'codex',
    };
    const legacy: PersistedSession = {
      id: 'sess-b', project: PROJECT, createdAt: 1, updatedAt: 1, messages: [],
    };
    const { store } = makeStore([withAgent, legacy]);
    const registry = makeRegistry({ [PROJECT]: {} });

    const metas = new ListSessionsUseCase({ registry, sessions: store }).execute(PROJECT);

    expect(metas.find((m) => m.id === 'sess-a')?.agentId).toBe('codex');
    expect('agentId' in (metas.find((m) => m.id === 'sess-b') ?? {})).toBe(false);
  });
});
