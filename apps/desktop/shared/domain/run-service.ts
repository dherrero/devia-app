/**
 * Data contracts for the `RunService` (TS-Agent-03).
 *
 * Defined in shared/domain so both the main-process orchestrator and
 * renderer-facing transport layers can import from one place without
 * circular dependencies or Electron imports.
 */

import type { NormalizedEvent } from './normalized-event';
import type { AgentRunStatus } from './chat-session';

export type { AgentRunStatus };

// ── Run record ────────────────────────────────────────────────────────────────

export interface RunRecord {
  runId: string;
  providerId: string;
  status: AgentRunStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  failureCode?: string;
  failureMessage?: string;
  projectId?: string;
  conversationId?: string;
  /** Stored for idempotency-key deduplication. */
  idempotencyKey?: string;
}

// ── Event envelope ────────────────────────────────────────────────────────────

export interface RunEventEnvelope {
  runId: string;
  /** Monotonically increasing within the run. */
  sequence: number;
  emittedAt: number;
  payload: NormalizedEvent;
}

// ── Create request ────────────────────────────────────────────────────────────

export interface ChatTurnSummary {
  role: 'user' | 'assistant';
  content: string;
}

export interface CreateRunRequest {
  providerId: string;
  prompt: string;
  history?: ChatTurnSummary[];
  projectId?: string;
  conversationId?: string;
  cwd: string;
  model?: string;
  reasoningLevel?: string;
  imagePaths?: string[];
  idempotencyKey?: string;
}

// ── Service options ───────────────────────────────────────────────────────────

export interface RunServiceOptions {
  /** Milliseconds of silence before the watchdog aborts the run. Default 600 000. */
  inactivityTimeoutMs: number;
  /** SIGTERM grace window before SIGKILL. Default 2 000. */
  cancelGraceMs: number;
  /** How long idempotency keys are retained. Default 24 h. */
  idempotencyRetentionMs: number;
  /** Maximum parallel runs. Default 4. */
  maxConcurrentRuns: number;
}

export const DEFAULT_RUN_SERVICE_OPTIONS: RunServiceOptions = {
  inactivityTimeoutMs: 600_000,
  cancelGraceMs: 2_000,
  idempotencyRetentionMs: 24 * 60 * 60 * 1000,
  maxConcurrentRuns: 4,
};

// ── Stream handle ─────────────────────────────────────────────────────────────

export interface RunStream {
  envelopes: AsyncIterable<RunEventEnvelope>;
  cancel(reason: 'client_disconnect'): void;
}
