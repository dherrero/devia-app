/**
 * Unified error envelope and error code catalogue for the agent pipeline
 * (TS-Agent-09).
 *
 * Every error that crosses an agent boundary must conform to `ChatError` so
 * the renderer, orchestrator, and transport layer handle failures identically.
 *
 * Defined in shared/domain so it is importable by both main-process and renderer
 * without circular dependencies or Electron imports.
 */

// ── Error codes ───────────────────────────────────────────────────────────────

export type ChatErrorCode =
  | 'BAD_REQUEST'
  | 'PROVIDER_UNKNOWN'
  | 'PROVIDER_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'PROMPT_TOO_LARGE'
  | 'SPAWN_FAILED'
  | 'INACTIVITY_TIMEOUT'
  | 'PARSER_DESYNC'
  | 'EMPTY_OUTPUT'
  | 'STORE_CONFLICT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'CANCELED'
  | 'INTERNAL';

// ── Error envelope ────────────────────────────────────────────────────────────

export interface ChatError {
  code: ChatErrorCode | (string & Record<never, never>);
  message: string;
  /**
   * `true` when the user can fix the condition and retry
   * (e.g. sign in, reduce prompt size).
   */
  recoverable: boolean;
  /**
   * `true` when an immediate retry is safe without user intervention.
   */
  retryable: boolean;
  /**
   * Short remediation hint surfaced as a link or tooltip in the UI.
   * Must be a URL from the trusted allowlist — the renderer validates before rendering.
   */
  recoveryHint?: string;
  /** Arbitrary error metadata for the diagnostic bundle. */
  details?: Record<string, unknown>;
  /**
   * Suggested delay before the next retry (milliseconds).
   * Used for rate-limit back-off.
   */
  retryAfterMs?: number;
}

// ── Request types ─────────────────────────────────────────────────────────────

export interface CancelRequest {
  runId: string;
  reason: 'user' | 'shutdown';
}

export interface RetryRequest {
  /** Run to retry from. */
  runId: string;
  /** New idempotency key for the retry attempt. */
  idempotencyKey: string;
  amendments?: {
    model?: string;
    reasoningLevel?: string;
    promptEdit?: string;
  };
}

// ── Type guard ────────────────────────────────────────────────────────────────

export function isChatError(value: unknown): value is ChatError {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['code'] === 'string' &&
    typeof v['message'] === 'string' &&
    typeof v['recoverable'] === 'boolean' &&
    typeof v['retryable'] === 'boolean'
  );
}

// ── Factory helpers ───────────────────────────────────────────────────────────

export function makeChatError(
  code: ChatError['code'],
  message: string,
  opts: Partial<Omit<ChatError, 'code' | 'message'>> = {},
): ChatError {
  return {
    code,
    message,
    recoverable: opts.recoverable ?? false,
    retryable: opts.retryable ?? false,
    ...(opts.recoveryHint !== undefined ? { recoveryHint: opts.recoveryHint } : {}),
    ...(opts.details !== undefined ? { details: opts.details } : {}),
    ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
  };
}
