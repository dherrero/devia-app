import { describe, it, expect } from 'vitest';
import { LoadChatsUseCase } from './load-chats.use-case';
import type { ProjectRegistry, ProjectRecord } from '../../../shared/ports';
import type { SessionStore } from '../../../shared/ports';

// ── Minimal stubs ──────────────────────────────────────────────────────────

function makeRegistry(projects: Array<{ name: string; activeSessionId: string | null }>): ProjectRegistry {
  const entries = new Map<string, ProjectRecord>(
    projects.map(({ name, activeSessionId }) => [
      name,
      {
        name,
        isRunning: false,
        newSession: false,
        activeSessionId,
        // ProjectRegistry methods not used by LoadChatsUseCase — stub with no-ops
      } as ProjectRecord,
    ]),
  );

  return {
    entries: () => entries.entries() as IterableIterator<readonly [string, ProjectRecord]>,
    // Unused by use case — satisfy type with stubs
    getOrCreate: () => { throw new Error('not used'); },
    find: () => undefined,
    has: () => false,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    delete: () => {},
    values: () => entries.values(),
    paths: () => [...entries.keys()],
    isRunning: () => false,
    runningCount: () => 0,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    stopProject: () => {},
    stopAll: () => [],
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    renamePrefix: () => {},
    deletePrefix: () => [],
  };
}

function makeSessionStore(messages: unknown[]): SessionStore {
  return {
    load: (project, id) => ({ id, project, messages, createdAt: 0, updatedAt: 0 }),
    // Unused methods
    newSessionId: () => 'fake-id',
    isValidSessionId: (id): id is string => typeof id === 'string' && id.length > 0,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    save: () => {},
    list: () => [],
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    deleteOne: () => {},
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    deleteProjectSessions: () => {},
    collectAllStats: () => [],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('LoadChatsUseCase', () => {
  const PROJECT = '/workspace/my-project';

  function makeUseCase(messages: unknown[]) {
    const registry = makeRegistry([{ name: PROJECT, activeSessionId: 'session-001' }]);
    const sessions = makeSessionStore(messages);
    return new LoadChatsUseCase({ registry, sessions });
  }

  it('downgrades runStatus:running to failed on load', () => {
    const useCase = makeUseCase([
      { id: 'msg-1', role: 'assistant', text: 'hello', runStatus: 'running' },
    ]);
    const result = useCase.execute();
    const messages = result[PROJECT] as Array<Record<string, unknown>>;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(messages[0]!['runStatus']).toBe('failed');
  });

  it('sets endedAt when downgrading runStatus:running', () => {
    const before = Date.now();
    const useCase = makeUseCase([
      { id: 'msg-1', role: 'assistant', runStatus: 'running' },
    ]);
    const result = useCase.execute();
    const after = Date.now();
    const messages = result[PROJECT] as Array<Record<string, unknown>>;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const endedAt = messages[0]!['endedAt'] as number;
    expect(endedAt).toBeGreaterThanOrEqual(before);
    expect(endedAt).toBeLessThanOrEqual(after);
  });

  it('does not modify messages with runStatus:succeeded', () => {
    const msg = { id: 'msg-1', role: 'assistant', text: 'done', runStatus: 'succeeded' };
    const useCase = makeUseCase([msg]);
    const result = useCase.execute();
    const messages = result[PROJECT] as Array<Record<string, unknown>>;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(messages[0]!).toEqual(msg);
  });

  it('does not modify messages with runStatus:failed', () => {
    const msg = { id: 'msg-1', role: 'assistant', runStatus: 'failed', endedAt: 12345 };
    const useCase = makeUseCase([msg]);
    const result = useCase.execute();
    const messages = result[PROJECT] as Array<Record<string, unknown>>;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(messages[0]!).toEqual(msg);
  });

  it('does not modify messages without runStatus (old format)', () => {
    // Old persisted format: no runStatus, no usage, no toolCalls
    const msg = { id: 'msg-1', role: 'assistant', text: 'legacy message' };
    const useCase = makeUseCase([msg]);
    const result = useCase.execute();
    const messages = result[PROJECT] as Array<Record<string, unknown>>;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(messages[0]!).toBe(msg); // same reference — not cloned/modified
  });

  it('handles multiple messages, upgrading only running ones', () => {
    const msgs = [
      { id: 'msg-1', role: 'user', text: 'hello' },
      { id: 'msg-2', role: 'assistant', runStatus: 'running' },
      { id: 'msg-3', role: 'assistant', runStatus: 'succeeded' },
      { id: 'msg-4', role: 'assistant', runStatus: 'running' },
    ];
    const useCase = makeUseCase(msgs);
    const result = useCase.execute();
    const messages = result[PROJECT] as Array<Record<string, unknown>>;
    expect(messages[0]).toBe(msgs[0]); // unchanged
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(messages[1]!['runStatus']).toBe('failed');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(messages[2]!['runStatus']).toBe('succeeded'); // unchanged
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(messages[3]!['runStatus']).toBe('failed');
  });

  it('skips projects without an activeSessionId', () => {
    const registry = makeRegistry([
      { name: '/no-session-project', activeSessionId: null },
    ]);
    const sessions = makeSessionStore([{ id: 'msg-1', role: 'user', text: 'hi' }]);
    const useCase = new LoadChatsUseCase({ registry, sessions });
    const result = useCase.execute();
    expect(result['/no-session-project']).toBeUndefined();
  });

  it('sets endedAt to a positive timestamp when downgrading from running', () => {
    // Verify that the spread overwrites endedAt with the current timestamp (not
    // the original persisted one, which may be 0 or undefined for crashed runs).
    const useCase = makeUseCase([
      { id: 'msg-1', role: 'assistant', runStatus: 'running', endedAt: undefined },
    ]);
    const result = useCase.execute();
    const messages = result[PROJECT] as Array<Record<string, unknown>>;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(typeof messages[0]!['endedAt']).toBe('number');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect((messages[0]!['endedAt'] as number)).toBeGreaterThan(0);
  });
});
