import type { MatcherRule } from './shared';

/**
 * Cursor Agent CLI patterns. Cursor's CLI runs against Cursor's own
 * cloud API; auth is via the user's Cursor login session, not an API key.
 */
export const CURSOR_AGENT_RULES: readonly MatcherRule[] = [
  {
    pattern: /not (logged in|signed in)|cursor[- ]login/i,
    reason: 'auth_required',
    hint: 'Run `cursor-agent login`.',
  },
  {
    pattern: /session.*expired/i,
    reason: 'rotate_credential',
  },
  {
    pattern: /cursor.*usage.*limit/i,
    reason: 'quota_exceeded',
    hint: 'Upgrade your Cursor plan or wait for the cycle to reset.',
  },
  {
    pattern: /pro.*plan.*required/i,
    reason: 'quota_exceeded',
  },
];
