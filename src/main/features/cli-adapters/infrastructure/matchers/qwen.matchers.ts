import type { MatcherRule } from './shared';

/**
 * Qwen (Alibaba DashScope) CLI patterns. DashScope returns chinese and
 * english error strings; hermes' `_RATE_LIMIT_PATTERNS` already covers
 * "rate increased too quickly" — the qwen-specific lines below catch
 * the remaining shapes.
 */
export const QWEN_RULES: readonly MatcherRule[] = [
  {
    pattern: /DASHSCOPE_API_KEY|QWEN_API_KEY/i,
    reason: 'auth_required',
    hint: 'Set DASHSCOPE_API_KEY in Settings → Agent → Qwen.',
  },
  {
    pattern: /InvalidApiKey|InvalidParameter\.Auth/i,
    reason: 'auth_required',
  },
  // Chinese surface — kept verbatim so the pattern fires even when the
  // CLI passes the upstream message through without translation.
  {
    pattern: /超过最大长度|上下文长度/,
    reason: 'compress_context',
  },
  {
    pattern: /账户.*余额|余额不足/,
    reason: 'quota_exceeded',
    hint: 'Top up your DashScope account.',
  },
  {
    pattern: /Throttling\.User|RequestLimitExceeded/i,
    reason: 'rate_limited',
  },
];
