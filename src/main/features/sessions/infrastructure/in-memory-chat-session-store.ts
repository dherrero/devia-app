import type {
  AgentRun,
  Conversation,
  RunEvent,
  SessionMessage,
} from '../../../../shared/domain/chat-session';
import { StoreConflictError } from '../../../../shared/domain/chat-session';
import type {
  ChatSessionStore,
  ConversationRepository,
  MessageRepository,
  RunEventRepository,
  RunRepository,
} from '../domain/chat-session-repositories';

/**
 * In-memory implementation of `ChatSessionStore`.
 *
 * Suitable for unit tests and as a reference implementation. A production
 * deployment would replace this with a SQLite-backed store (better-sqlite3)
 * once the dependency is added — the interface contract stays identical.
 *
 * All repositories share the same Maps so `deleteConversation` can cascade
 * atomically.
 */
export class InMemoryChatSessionStore implements ChatSessionStore {
  private readonly _conversations = new Map<string, Conversation>();
  private readonly _messages = new Map<string, SessionMessage>();
  private readonly _runs = new Map<string, AgentRun>();
  /** Indexed as `${runId}:${sequence}` for O(1) collision detection. */
  private readonly _runEvents = new Map<string, RunEvent>();
  /** Secondary index: runId → sorted event list */
  private readonly _runEventsByRun = new Map<string, RunEvent[]>();

  // ── Conversation repo ───────────────────────────────────────────────────────

  readonly conversations: ConversationRepository = {
    insert: (c) => { this._conversations.set(c.id, { ...c }); },
    getById: (id) => this._conversations.get(id),
    listByProject: (projectId, opts) => {
      let items = [...this._conversations.values()].filter((c) => c.projectId === projectId);
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      if (opts?.before !== undefined) {
        items = items.filter((c) => c.updatedAt < (opts.before as number));
      }
      if (opts?.limit !== undefined) items = items.slice(0, opts.limit);
      return items;
    },
    updateTitle: (id, title, updatedAt) => {
      const c = this._conversations.get(id);
      if (c) { c.title = title; c.updatedAt = updatedAt; }
    },
    delete: (id) => { this._conversations.delete(id); },
  };

  // ── Message repo ────────────────────────────────────────────────────────────

  readonly messages: MessageRepository = {
    insert: (m) => { this._messages.set(m.id, { ...m }); },
    setRunStatus: (messageId, status, endedAt) => {
      const m = this._messages.get(messageId);
      if (m) { m.runStatus = status; m.endedAt = endedAt; }
    },
    listByConversation: (conversationId, opts) => {
      let items = [...this._messages.values()].filter((m) => m.conversationId === conversationId);
      items.sort((a, b) => a.createdAt - b.createdAt);
      if (opts?.before !== undefined) {
        items = items.filter((m) => m.createdAt < (opts.before as number));
      }
      if (opts?.limit !== undefined) items = items.slice(0, opts.limit);
      return items;
    },
    getById: (id) => this._messages.get(id),
    deleteByConversation: (conversationId) => {
      for (const [id, m] of this._messages) {
        if (m.conversationId === conversationId) this._messages.delete(id);
      }
    },
  };

  // ── Run repo ────────────────────────────────────────────────────────────────

  readonly runs: RunRepository = {
    insert: (r) => { this._runs.set(r.id, { ...r }); },
    setStatus: (runId, status, opts = {}) => {
      const r = this._runs.get(runId);
      if (!r) return;
      r.status = status;
      if (opts.endedAt !== undefined) r.endedAt = opts.endedAt;
      if (opts.failureCode !== undefined) r.failureCode = opts.failureCode;
      if (opts.failureMessage !== undefined) r.failureMessage = opts.failureMessage;
      if ('exitCode' in opts) r.exitCode = opts.exitCode;
      if ('exitSignal' in opts) r.exitSignal = opts.exitSignal;
    },
    getById: (id) => this._runs.get(id),
    listByConversation: (conversationId) =>
      [...this._runs.values()].filter((r) => r.conversationId === conversationId),
    listRunning: () =>
      [...this._runs.values()].filter((r) => r.status === 'running'),
    deleteByConversation: (conversationId) => {
      for (const [id, r] of this._runs) {
        if (r.conversationId === conversationId) {
          this._runs.delete(id);
          this._runEventsByRun.delete(id);
        }
      }
    },
  };

  // ── Run event repo ──────────────────────────────────────────────────────────

  readonly runEvents: RunEventRepository = {
    append: (event) => {
      const key = `${event.runId}:${event.sequence}`;
      if (this._runEvents.has(key)) {
        throw new StoreConflictError(event.runId, event.sequence);
      }
      this._runEvents.set(key, { ...event });
      if (!this._runEventsByRun.has(event.runId)) {
        this._runEventsByRun.set(event.runId, []);
      }
      // Insert in sequence order (usually appended monotonically)
      const list = this._runEventsByRun.get(event.runId);
      if (!list) return;
      const idx = list.findIndex((e) => e.sequence > event.sequence);
      if (idx === -1) list.push({ ...event });
      else list.splice(idx, 0, { ...event });
    },
    list: (runId, since) => {
      const list = this._runEventsByRun.get(runId) ?? [];
      return since !== undefined ? list.filter((e) => e.sequence > since) : [...list];
    },
    deleteByConversation: (conversationId) => {
      const runIds = new Set(
        [...this._runs.values()]
          .filter((r) => r.conversationId === conversationId)
          .map((r) => r.id),
      );
      for (const [key, event] of this._runEvents) {
        if (runIds.has(event.runId)) this._runEvents.delete(key);
      }
      for (const runId of runIds) {
        this._runEventsByRun.delete(runId);
      }
    },
  };

  // ── Composed operations ─────────────────────────────────────────────────────

  deleteConversation(conversationId: string): void {
    this.runEvents.deleteByConversation(conversationId);
    this.runs.deleteByConversation(conversationId);
    this.messages.deleteByConversation(conversationId);
    this.conversations.delete(conversationId);
  }

  reconcileOrphanedRuns(): number {
    const running = this.runs.listRunning();
    let count = 0;
    for (const run of running) {
      this.runs.setStatus(run.id, 'failed', {
        failureCode: 'PROCESS_LOST',
        failureMessage: 'Process ended without emitting a terminal status',
        endedAt: Date.now(),
      });
      this.messages.setRunStatus(run.messageId, 'failed', Date.now());
      count++;
    }
    return count;
  }

  sweepOldConversations(ttlMs: number): number {
    const cutoff = Date.now() - ttlMs;
    const toDelete: string[] = [];
    for (const c of this._conversations.values()) {
      if (c.updatedAt < cutoff) toDelete.push(c.id);
    }
    for (const id of toDelete) {
      this.deleteConversation(id);
    }
    return toDelete.length;
  }

  /** Total event count — useful for tests and diagnostics. */
  get totalEventCount(): number {
    return this._runEvents.size;
  }
}
