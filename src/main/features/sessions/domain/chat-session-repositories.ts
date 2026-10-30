import type {
  AgentRun,
  AgentRunStatus,
  Conversation,
  RunEvent,
  SessionMessage,
} from '../../../../shared/domain/chat-session';

// ── Conversation repository ───────────────────────────────────────────────────

export interface ConversationRepository {
  insert(conversation: Conversation): void;
  getById(id: string): Conversation | undefined;
  listByProject(projectId: string, opts?: { limit?: number; before?: number }): Conversation[];
  updateTitle(id: string, title: string, updatedAt: number): void;
  delete(id: string): void;
}

// ── Message repository ────────────────────────────────────────────────────────

export interface MessageRepository {
  insert(message: SessionMessage): void;
  setRunStatus(
    messageId: string,
    status: AgentRunStatus,
    endedAt: number,
  ): void;
  listByConversation(
    conversationId: string,
    opts?: { limit?: number; before?: number },
  ): SessionMessage[];
  getById(id: string): SessionMessage | undefined;
  /** Cascade-deleted when its conversation is deleted. */
  deleteByConversation(conversationId: string): void;
}

// ── Run repository ────────────────────────────────────────────────────────────

export interface RunRepository {
  insert(run: AgentRun): void;
  setStatus(
    runId: string,
    status: AgentRunStatus,
    opts?: {
      endedAt?: number;
      failureCode?: string;
      failureMessage?: string;
      exitCode?: number | null;
      exitSignal?: string | null;
    },
  ): void;
  getById(id: string): AgentRun | undefined;
  listByConversation(conversationId: string): AgentRun[];
  /** Returns all runs currently in `running` status. */
  listRunning(): AgentRun[];
  deleteByConversation(conversationId: string): void;
}

// ── Run event repository ──────────────────────────────────────────────────────

export interface RunEventRepository {
  /**
   * Append an event. Throws `StoreConflictError` if `(runId, sequence)` already exists.
   */
  append(event: RunEvent): void;
  /**
   * List events for a run in sequence order, optionally starting after `since`.
   */
  list(runId: string, since?: number): RunEvent[];
  deleteByConversation(conversationId: string): void;
}

// ── Chat session store (composed facade) ──────────────────────────────────────

export interface ChatSessionStore {
  conversations: ConversationRepository;
  messages: MessageRepository;
  runs: RunRepository;
  runEvents: RunEventRepository;

  /**
   * Delete a conversation and all its dependent messages, runs, and run_events
   * in a single atomic operation.
   */
  deleteConversation(conversationId: string): void;

  /**
   * Mark any `running` messages whose run is no longer alive as `failed`
   * with `failureCode: 'PROCESS_LOST'`. Called at startup.
   */
  reconcileOrphanedRuns(): number;

  /**
   * Delete conversations older than `ttlMs` milliseconds.
   * Returns the number of conversations deleted.
   */
  sweepOldConversations(ttlMs: number): number;
}
