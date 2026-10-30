import type { ChatError } from '../../../../shared/domain/chat-error';

/**
 * Produces a redacted JSON diagnostic bundle safe to share for support.
 *
 * Redacts:
 *  - Values of any field whose key matches a credential pattern (API key,
 *    token, secret, password, credential).
 *  - Absolute file paths that don't start with a known safe prefix.
 *  - Any string value longer than 512 chars is truncated with a marker.
 *
 * The bundle contains run id, provider id, timestamps, and error metadata.
 * It never includes prompt text, tool inputs, or chat history.
 */

export interface DiagnosticInput {
  runId: string;
  providerId: string;
  startedAt?: number;
  endedAt?: number;
  error?: ChatError;
  extra?: Record<string, unknown>;
}

// ── Redaction ─────────────────────────────────────────────────────────────────

const CREDENTIAL_KEY_PATTERN = /api[_\s-]?key|token|secret|password|passwd|credential/i;
const ABS_PATH_PATTERN = /^[A-Za-z]:[/\\]|^\//;

function redactValue(key: string, value: unknown): unknown {
  if (CREDENTIAL_KEY_PATTERN.test(key)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    if (ABS_PATH_PATTERN.test(value)) return '[PATH_REDACTED]';
    if (value.length > 512) return value.slice(0, 512) + '…[truncated]';
    return value;
  }
  return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactObject(v as Record<string, unknown>);
    } else {
      out[k] = redactValue(k, v);
    }
  }
  return out;
}

// ── Bundle builder ────────────────────────────────────────────────────────────

export interface DiagnosticBundle {
  schemaVersion: 1;
  generatedAt: number;
  runId: string;
  providerId: string;
  startedAt?: number;
  endedAt?: number;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  extra?: Record<string, unknown>;
}

export function buildDiagnosticBundle(input: DiagnosticInput): DiagnosticBundle {
  const bundle: DiagnosticBundle = {
    schemaVersion: 1,
    generatedAt: Date.now(),
    runId: input.runId,
    providerId: input.providerId,
  };

  if (input.startedAt !== undefined) bundle.startedAt = input.startedAt;
  if (input.endedAt !== undefined) bundle.endedAt = input.endedAt;

  if (input.error) {
    const { code, message, recoverable, retryable, details } = input.error;
    bundle.error = {
      code,
      message: redactValue('message', message) as string,
      recoverable,
      retryable,
      ...(details !== undefined ? { details: redactObject(details) } : {}),
    };
  }

  if (input.extra) {
    bundle.extra = redactObject(input.extra);
  }

  return bundle;
}

export function bundleToClipboardText(bundle: DiagnosticBundle): string {
  return JSON.stringify(bundle, null, 2);
}
