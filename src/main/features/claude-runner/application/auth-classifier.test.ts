import { describe, it, expect } from 'vitest';
import { classifyAuthError } from './auth-classifier';

/**
 * After E-DSK-09 #262 `classifyAuthError` delegates the pattern matching
 * to the unified per-CLI taxonomy in `cli-adapters/infrastructure/`.
 * These tests now only cover what this module still owns: turning an
 * `auth_required` outcome into a typed {@link ChatError} carrying the
 * right `devia://settings/agents/<provider>` deep link.
 *
 * Per-pattern coverage moved to
 * `cli-adapters/infrastructure/matchers/matchers.test.ts`.
 */
describe('classifyAuthError', () => {
  it('detects "not logged in" for claude and emits the claude deep link', () => {
    const err = classifyAuthError('claude', 'Error: not logged in to Claude');
    expect(err?.code).toBe('AUTH_REQUIRED');
    expect(err?.recoverable).toBe(true);
    expect(err?.retryable).toBe(false);
    expect(err?.recoveryHint).toBe('devia://settings/agents/claude');
  });

  it('detects invalid-api-key wording for codex with the codex deep link', () => {
    const err = classifyAuthError('codex', 'Invalid api key provided');
    expect(err?.code).toBe('AUTH_REQUIRED');
    expect(err?.recoveryHint).toBe('devia://settings/agents/codex');
  });

  it('detects gemini-style api-key errors with the gemini deep link', () => {
    const err = classifyAuthError('gemini', 'GEMINI_API_KEY not set');
    expect(err?.code).toBe('AUTH_REQUIRED');
    expect(err?.recoveryHint).toBe('devia://settings/agents/gemini');
  });

  it('returns undefined for unrelated stderr', () => {
    expect(classifyAuthError('claude', 'Some random error occurred')).toBeUndefined();
  });

  it('returns undefined for empty stderr', () => {
    expect(classifyAuthError('claude', '')).toBeUndefined();
  });

  it('returns undefined for an unknown provider whose CLI never produces this string', () => {
    // 'not logged in' is a claude-specific pattern; an unknown provider
    // falls back to generic rules which don't carry that phrase.
    expect(classifyAuthError('unknown-provider', 'not logged in')).toBeUndefined();
  });

  it('is case-insensitive for substring patterns', () => {
    const err = classifyAuthError('claude', 'ERROR: NOT LOGGED IN');
    expect(err?.code).toBe('AUTH_REQUIRED');
  });

  it('promotes rotate_credential outcomes to AUTH_REQUIRED', () => {
    // "session expired" is classified as rotate_credential on cursor-agent;
    // the renderer treats that as "log in again", so we surface it here.
    const err = classifyAuthError('cursor-agent', 'session expired, refresh token rejected');
    expect(err?.code).toBe('AUTH_REQUIRED');
    expect(err?.recoveryHint).toBe('devia://settings/agents/cursor-agent');
  });

  it('returns undefined when the classifier reports a non-auth reason', () => {
    // HTTP 429 is rate_limited, not auth — should not surface here.
    expect(
      classifyAuthError('codex', 'HTTP 429 rate limit exceeded'),
    ).toBeUndefined();
  });
});
