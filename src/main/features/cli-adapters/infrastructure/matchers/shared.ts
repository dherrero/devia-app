import type { FailoverReason } from '../../../../../shared/domain/cli-errors';

/**
 * One matcher rule: a regex (or substring, when prefixed by `s:`) that, if
 * it fires against the raw message, maps to a {@link FailoverReason}.
 *
 * Order matters — earlier rules win. The per-CLI matcher arrays are
 * intentionally ordered most-specific → most-generic so a generic "rate
 * limit" pattern does not pre-empt a more meaningful "billing exhausted"
 * one for the same CLI.
 *
 * `hint` is forwarded into the `ClassifiedError.hint` field; tested
 * verbatim so reordering rules doesn't silently change UX copy.
 */
export interface MatcherRule {
  readonly pattern: RegExp;
  readonly reason: FailoverReason;
  readonly hint?: string;
}

/**
 * Provider-agnostic patterns ported from hermes' `_RATE_LIMIT_PATTERNS`,
 * `_BILLING_PATTERNS`, `_AUTH_PATTERNS`, `_CONTEXT_OVERFLOW_PATTERNS` and
 * `_MODEL_NOT_FOUND_PATTERNS`. Every per-CLI matcher table appends these
 * after its own CLI-specific rules so the generic catch-alls always run
 * last.
 *
 * These are the floor of recognition: when a CLI matcher doesn't carry a
 * provider-specific rule for, say, "context window exceeded", the
 * generic table catches the english string anyway.
 */
export const GENERIC_RULES: readonly MatcherRule[] = [
  // ── Billing / quota exhaustion (terminal for the current plan) ──
  { pattern: /insufficient (credits?|balance|quota)/i, reason: 'quota_exceeded' },
  { pattern: /credit balance|credits have been exhausted|top up your credits/i, reason: 'quota_exceeded' },
  { pattern: /payment required|billing hard limit/i, reason: 'quota_exceeded' },
  { pattern: /exceeded your current quota/i, reason: 'quota_exceeded' },
  { pattern: /plan does not include/i, reason: 'quota_exceeded' },
  { pattern: /\b402\b/, reason: 'quota_exceeded' },

  // ── Rate limit (transient) ──
  { pattern: /\b429\b/, reason: 'rate_limited' },
  { pattern: /rate[ _-]?limit(ed|ing)?/i, reason: 'rate_limited' },
  { pattern: /too many requests/i, reason: 'rate_limited' },
  { pattern: /throttl(ed|ing)/i, reason: 'rate_limited' },
  { pattern: /requests per (minute|day)|tokens per minute/i, reason: 'rate_limited' },
  { pattern: /try again in/i, reason: 'rate_limited' },
  { pattern: /please retry after/i, reason: 'rate_limited' },
  { pattern: /resource_exhausted/i, reason: 'rate_limited' },

  // ── Auth ──
  { pattern: /\b40(1|3)\b/, reason: 'auth_required' },
  { pattern: /invalid api[ _-]?key/i, reason: 'auth_required' },
  { pattern: /api[ _-]?key.{0,16}invalid/i, reason: 'auth_required' },
  { pattern: /(missing|no) api[ _-]?key/i, reason: 'auth_required' },
  { pattern: /api[ _-]?key (not (set|found)|missing|required)/i, reason: 'auth_required' },
  { pattern: /unauthorized/i, reason: 'auth_required' },
  { pattern: /forbidden/i, reason: 'auth_required' },
  { pattern: /token (expired|revoked)/i, reason: 'rotate_credential' },
  { pattern: /access denied/i, reason: 'auth_required' },
  { pattern: /authentication (required|failed|error)/i, reason: 'auth_required' },
  // Generic "auth … fail" — catches "auth validation fail", "auth check failed", …
  { pattern: /\bauth(entication)?\b[^\n]{0,40}\bfail/i, reason: 'auth_required' },

  // ── Context overflow ──
  { pattern: /context (length|size|window)/i, reason: 'compress_context' },
  { pattern: /maximum context|max(imum)? (model length|number of tokens)/i, reason: 'compress_context' },
  { pattern: /token limit|too many tokens/i, reason: 'compress_context' },
  { pattern: /reduce the length/i, reason: 'compress_context' },
  { pattern: /prompt (is too long|exceeds max length|length|too large)/i, reason: 'compress_context' },
  { pattern: /input is too long/i, reason: 'compress_context' },
  { pattern: /enametoolong/i, reason: 'compress_context' },

  // ── Model not found / deprecated ──
  { pattern: /(invalid|unknown|unsupported) model/i, reason: 'model_unavailable' },
  { pattern: /model not found|model_not_found/i, reason: 'model_unavailable' },
  { pattern: /does not exist|no such model/i, reason: 'model_unavailable' },
  { pattern: /is not a valid model/i, reason: 'model_unavailable' },

  // ── Transient network / server ──
  { pattern: /\b(500|502|503|504|529)\b/, reason: 'retry' },
  { pattern: /(server|service) (error|unavailable)/i, reason: 'retry' },
  { pattern: /(overloaded|temporarily unavailable)/i, reason: 'retry' },
  { pattern: /\btimeout\b|timed out|connection reset|econnreset|econnrefused/i, reason: 'retry' },
  { pattern: /reconnecting|timeout waiting for child process/i, reason: 'retry' },
];

/**
 * Parse a `Retry-After` style hint out of the raw message. Anthropic and
 * OpenAI both surface this on 429s in different shapes:
 *   - "Please retry after 12 seconds"
 *   - "try again in 30s"
 *   - "Retry-After: 60"
 *   - "rate_limit_exceeded ... retry after 86400"
 *
 * Returns `undefined` when no hint is present; the renderer falls back
 * to its default cooldown when the value is missing.
 */
export function parseRetryAfter(message: string): number | undefined {
  const minutes = /try again in\s+(\d+)\s*m(in)?/i.exec(message);
  if (minutes?.[1]) return Number(minutes[1]) * 60;
  const seconds = /(?:retry[- ]?after[:\s]+|try again in\s+|retry after\s+)(\d+)\s*(s|sec|seconds?)?/i.exec(message);
  if (seconds?.[1]) return Number(seconds[1]);
  return undefined;
}

/**
 * Find the first {@link MatcherRule} that fires against `message`. Used
 * by every per-CLI matcher to walk its own rules first, then the generic
 * rules. Returns `undefined` when no rule matches so the caller can fall
 * back to `unrecoverable`.
 */
export function firstMatch(
  message: string,
  rules: readonly MatcherRule[],
): MatcherRule | undefined {
  for (const rule of rules) {
    if (rule.pattern.test(message)) return rule;
  }
  return undefined;
}
