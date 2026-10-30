/**
 * Domain types for the chat session model (TS-Agent-05).
 *
 * These are the canonical types for conversations, messages, agent runs, and
 * per-run events. They are defined in shared/domain so both the main-process
 * persistence layer and the renderer can import them without Electron imports.
 *
 * `NormalizedEvent` from TS-Agent-04 is the payload type for `RunEvent`.
 */

import type { NormalizedEvent } from './normalized-event';

// ── Run status ────────────────────────────────────────────────────────────────

/**
 * Lifecycle status of an agent run.
 * `queued` extends the renderer's existing `RunStatus` union to include
 * pre-spawn waiting state.
 */
export type AgentRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

// ── Conversation ──────────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  projectId?: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
}

// ── Message ───────────────────────────────────────────────────────────────────

export type SessionMessageRole = 'user' | 'assistant';

export interface SessionMessage {
  id: string;
  conversationId: string;
  role: SessionMessageRole;
  /** For assistant rows: text derived from text_delta events. */
  content: string;
  providerId?: string;
  runId?: string;
  runStatus?: AgentRunStatus;
  startedAt?: number;
  endedAt?: number;
  createdAt: number;
}

// ── Run ───────────────────────────────────────────────────────────────────────

export interface AgentRun {
  id: string;
  conversationId: string;
  /** The assistant message this run produces. */
  messageId: string;
  providerId: string;
  model?: string;
  reasoningLevel?: string;
  status: AgentRunStatus;
  failureCode?: string;
  failureMessage?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  startedAt: number;
  endedAt?: number;
}

// ── Run event ─────────────────────────────────────────────────────────────────

export interface RunEvent {
  runId: string;
  /** Monotonically increasing per run. Append throws on collision. */
  sequence: number;
  emittedAt: number;
  payload: NormalizedEvent;
}

// ── Store errors ──────────────────────────────────────────────────────────────

export class StoreConflictError extends Error {
  constructor(runId: string, sequence: number) {
    super(`Sequence collision in run "${runId}" at sequence ${sequence}`);
    this.name = 'StoreConflictError';
  }
}

export class StoreUnavailableError extends Error {
  constructor(detail?: string) {
    super(`Store unavailable${detail ? ': ' + detail : ''}`);
    this.name = 'StoreUnavailableError';
  }
}
