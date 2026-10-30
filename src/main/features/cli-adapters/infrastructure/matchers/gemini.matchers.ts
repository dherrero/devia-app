import type { MatcherRule } from './shared';

/**
 * Gemini CLI patterns. Gemini's CLI wraps the Google AI Studio API,
 * which surfaces gRPC-status-code style messages
 * (`RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`, …) on top of HTTP codes.
 */
export const GEMINI_RULES: readonly MatcherRule[] = [
  {
    pattern: /GOOGLE_API_KEY|GEMINI_API_KEY/i,
    reason: 'auth_required',
    hint: 'Set GEMINI_API_KEY (or GOOGLE_API_KEY) in Settings → Agent → Gemini.',
  },
  {
    pattern: /PERMISSION_DENIED/i,
    reason: 'auth_required',
  },
  {
    pattern: /UNAUTHENTICATED/i,
    reason: 'auth_required',
  },
  {
    pattern: /RESOURCE_EXHAUSTED/i,
    reason: 'rate_limited',
  },
  {
    pattern: /quota.*exceeded|exceeded.*quota/i,
    reason: 'quota_exceeded',
  },
  {
    pattern: /billing/i,
    reason: 'quota_exceeded',
  },
  // ── Gemini context overflow surface ──
  {
    pattern: /token count.*exceeds.*maximum/i,
    reason: 'compress_context',
  },
  {
    pattern: /total tokens.*exceed/i,
    reason: 'compress_context',
  },
  // ── Gemini-specific transient ──
  {
    pattern: /DEADLINE_EXCEEDED|UNAVAILABLE/i,
    reason: 'retry',
  },
];
