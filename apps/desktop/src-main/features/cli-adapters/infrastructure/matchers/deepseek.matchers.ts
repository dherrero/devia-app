import type { MatcherRule } from './shared';

/**
 * DeepSeek CLI patterns. DeepSeek's API is OpenAI-compatible so most
 * errors travel as standard `invalid_request_error` / `auth_error`
 * envelopes; the patterns below catch the DeepSeek-flavoured variants
 * before the generic table.
 */
export const DEEPSEEK_RULES: readonly MatcherRule[] = [
  {
    pattern: /DEEPSEEK_API_KEY/i,
    reason: 'auth_required',
    hint: 'Set DEEPSEEK_API_KEY in Settings → Agent → DeepSeek.',
  },
  {
    pattern: /deepseek.*invalid (token|key)/i,
    reason: 'auth_required',
  },
  {
    pattern: /deepseek.*insufficient.*balance/i,
    reason: 'quota_exceeded',
    hint: 'Add credit to your DeepSeek account.',
  },
  {
    pattern: /deepseek-chat.*not (available|enabled)/i,
    reason: 'model_unavailable',
  },
];
