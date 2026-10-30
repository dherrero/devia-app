import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryChatSessionStore } from './in-memory-chat-session-store';
import { StoreConflictError } from '../../../../shared/domain/chat-session';
import type { Conversation, SessionMessage, AgentRun, RunEvent } from '../../../../shared/domain/chat-session';
import type { NormalizedEvent } from '../../../../shared/domain/normalized-event';

let store: InMemoryChatSessionStore;

beforeEach(() => {
  store = new InMemoryChatSessionStore();
});

function makeConversation(id: string, projectId = 'proj-1', offsetMs = 0): Conversation {
  const now = Date.now() + offsetMs;
  return { id, projectId, createdAt: now, updatedAt: now };
}

function makeMessage(id: string, conversationId: string, content = ''): SessionMessage {
  return {
    id,
    conversationId,
    role: 'assistant',
    content,
    createdAt: Date.now(),
  };
}

function makeRun(id: string, conversationId: string, messageId: string): AgentRun {
  return {
    id,
    conversationId,
    messageId,
    providerId: 'echo',
    status: 'running',
    startedAt: Date.now(),
  };
}

function makeEvent(runId: string, sequence: number, text: string): RunEvent {
  const payload: NormalizedEvent = { kind: 'text_delta', text };
  return { runId, sequence, emittedAt: Date.now(), payload };
}

// ── Conversation repository ───────────────────────────────────────────────────

describe('conversations', () => {
  it('insert and getById', () => {
    const c = makeConversation('c1');
    store.conversations.insert(c);
    expect(store.conversations.getById('c1')).toMatchObject({ id: 'c1' });
  });

  it('listByProject ordered by updatedAt descending', () => {
    store.conversations.insert(makeConversation('old', 'p1', -1000));
    store.conversations.insert(makeConversation('new', 'p1', 0));
    const list = store.conversations.listByProject('p1');
    expect(list[0]?.id).toBe('new');
    expect(list[1]?.id).toBe('old');
  });

  it('listByProject limit', () => {
    store.conversations.insert(makeConversation('a', 'p'));
    store.conversations.insert(makeConversation('b', 'p'));
    const list = store.conversations.listByProject('p', { limit: 1 });
    expect(list).toHaveLength(1);
  });

  it('updateTitle', () => {
    store.conversations.insert(makeConversation('c1'));
    store.conversations.updateTitle('c1', 'New Title', Date.now());
    expect(store.conversations.getById('c1')?.title).toBe('New Title');
  });
});

// ── Message repository ────────────────────────────────────────────────────────

describe('messages', () => {
  it('insert and getById', () => {
    store.conversations.insert(makeConversation('c1'));
    store.messages.insert(makeMessage('m1', 'c1', 'hello'));
    expect(store.messages.getById('m1')?.content).toBe('hello');
  });

  it('listByConversation ordered by createdAt ascending', () => {
    store.conversations.insert(makeConversation('c1'));
    const m1 = { ...makeMessage('m1', 'c1'), createdAt: 100 };
    const m2 = { ...makeMessage('m2', 'c1'), createdAt: 200 };
    store.messages.insert(m2);
    store.messages.insert(m1);
    const list = store.messages.listByConversation('c1');
    expect(list[0]?.id).toBe('m1');
    expect(list[1]?.id).toBe('m2');
  });

  it('setRunStatus updates status and endedAt', () => {
    store.messages.insert(makeMessage('m1', 'c1'));
    store.messages.setRunStatus('m1', 'succeeded', 9999);
    expect(store.messages.getById('m1')?.runStatus).toBe('succeeded');
    expect(store.messages.getById('m1')?.endedAt).toBe(9999);
  });
});

// ── Run event repository ──────────────────────────────────────────────────────

describe('runEvents', () => {
  it('append and list in sequence order', () => {
    store.runEvents.append(makeEvent('r1', 1, 'a'));
    store.runEvents.append(makeEvent('r1', 2, 'b'));
    store.runEvents.append(makeEvent('r1', 3, 'c'));
    const list = store.runEvents.list('r1');
    expect(list.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  // AC1: event replay reconstructs content
  it('replay events to reconstruct assistant content (AC1)', () => {
    store.runEvents.append(makeEvent('r1', 1, 'Hello '));
    store.runEvents.append(makeEvent('r1', 2, 'world'));
    const events = store.runEvents.list('r1');
    const content = events
      .filter((e) => e.payload.kind === 'text_delta')
      .map((e) => (e.payload as { kind: 'text_delta'; text: string }).text)
      .join('');
    expect(content).toBe('Hello world');
  });

  // AC2: sequence collision throws StoreConflictError
  it('throws StoreConflictError on duplicate (runId, sequence) (AC2)', () => {
    store.runEvents.append(makeEvent('r1', 1, 'x'));
    expect(() => store.runEvents.append(makeEvent('r1', 1, 'y'))).toThrowError(StoreConflictError);
  });

  it('list with since returns events after that sequence', () => {
    store.runEvents.append(makeEvent('r1', 1, 'a'));
    store.runEvents.append(makeEvent('r1', 2, 'b'));
    store.runEvents.append(makeEvent('r1', 3, 'c'));
    const list = store.runEvents.list('r1', 1);
    expect(list.map((e) => e.sequence)).toEqual([2, 3]);
  });
});

// ── Composed operations ───────────────────────────────────────────────────────

// AC4: cascading delete
describe('deleteConversation (AC4)', () => {
  it('removes conversation, messages, runs, and events in one call', () => {
    store.conversations.insert(makeConversation('c1'));
    store.messages.insert(makeMessage('m1', 'c1'));
    store.runs.insert(makeRun('r1', 'c1', 'm1'));
    store.runEvents.append(makeEvent('r1', 1, 'hi'));

    store.deleteConversation('c1');

    expect(store.conversations.getById('c1')).toBeUndefined();
    expect(store.messages.getById('m1')).toBeUndefined();
    expect(store.runs.getById('r1')).toBeUndefined();
    expect(store.runEvents.list('r1')).toHaveLength(0);
  });
});

// AC3: startup reconciliation
describe('reconcileOrphanedRuns (AC3)', () => {
  it('marks running runs as failed with PROCESS_LOST', () => {
    store.conversations.insert(makeConversation('c1'));
    store.messages.insert(makeMessage('m1', 'c1'));
    store.runs.insert(makeRun('r1', 'c1', 'm1'));

    const count = store.reconcileOrphanedRuns();

    expect(count).toBe(1);
    expect(store.runs.getById('r1')?.status).toBe('failed');
    expect(store.runs.getById('r1')?.failureCode).toBe('PROCESS_LOST');
    expect(store.messages.getById('m1')?.runStatus).toBe('failed');
  });

  it('does not touch already-terminal runs', () => {
    store.conversations.insert(makeConversation('c1'));
    store.messages.insert(makeMessage('m1', 'c1'));
    const run = { ...makeRun('r1', 'c1', 'm1'), status: 'succeeded' as const };
    store.runs.insert(run);

    const count = store.reconcileOrphanedRuns();
    expect(count).toBe(0);
    expect(store.runs.getById('r1')?.status).toBe('succeeded');
  });
});

// AC5: retention TTL sweep
describe('sweepOldConversations (AC5)', () => {
  it('deletes conversations older than TTL', () => {
    const old = { ...makeConversation('old'), updatedAt: Date.now() - 100_000 };
    const recent = makeConversation('recent');
    store.conversations.insert(old);
    store.conversations.insert(recent);

    const deleted = store.sweepOldConversations(50_000); // 50s TTL
    expect(deleted).toBe(1);
    expect(store.conversations.getById('old')).toBeUndefined();
    expect(store.conversations.getById('recent')).toBeDefined();
  });

  it('cascades deletion during sweep', () => {
    const old = { ...makeConversation('old'), updatedAt: Date.now() - 100_000 };
    store.conversations.insert(old);
    store.messages.insert(makeMessage('m1', 'old'));
    store.runs.insert(makeRun('r1', 'old', 'm1'));
    store.runEvents.append(makeEvent('r1', 1, 'x'));

    store.sweepOldConversations(50_000);

    expect(store.messages.getById('m1')).toBeUndefined();
    expect(store.runs.getById('r1')).toBeUndefined();
    expect(store.runEvents.list('r1')).toHaveLength(0);
  });
});
