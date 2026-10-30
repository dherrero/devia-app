import type { MatcherRule } from './shared';

/**
 * GitHub Copilot CLI patterns. Auth is via the user's GitHub login
 * (device flow); errors typically reference GitHub or the Copilot
 * subscription.
 */
export const COPILOT_RULES: readonly MatcherRule[] = [
  {
    pattern: /gh auth (login|status)|github.*not (authenticated|logged)/i,
    reason: 'auth_required',
    hint: 'Run `gh auth login` (or `gh copilot setup`).',
  },
  {
    pattern: /copilot.*(subscription|access).*required/i,
    reason: 'quota_exceeded',
    hint: 'A GitHub Copilot subscription is required.',
  },
  {
    pattern: /copilot.*not (enabled|available)/i,
    reason: 'auth_required',
  },
  {
    pattern: /github.*api.*rate/i,
    reason: 'rate_limited',
  },
];
