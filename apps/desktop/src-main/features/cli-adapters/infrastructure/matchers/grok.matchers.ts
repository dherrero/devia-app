import type { MatcherRule } from './shared';

/**
 * Grok CLI (grok-dev / xAI) patterns. grok-dev wraps the xAI API
 * (`https://api.x.ai/v1`). Auth failures surface the `GROK_API_KEY` hint; the
 * generic table (`shared.ts`) catches HTTP 429 / quota / context overflow.
 */
export const GROK_RULES: readonly MatcherRule[] = [
  {
    pattern: /GROK_API_KEY|API key required/i,
    reason: 'auth_required',
    hint: 'Set GROK_API_KEY in Settings → Agent → Grok.',
  },
  {
    pattern: /x\.ai.*(unauthor|forbidden)|invalid.*xai/i,
    reason: 'auth_required',
  },
];
