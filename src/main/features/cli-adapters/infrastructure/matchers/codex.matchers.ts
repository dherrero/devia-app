import type { MatcherRule } from './shared';

/**
 * OpenAI Codex CLI patterns. Codex talks to the OpenAI Responses API and
 * surfaces both the API's structured errors (`invalid_request_error`,
 * `insufficient_quota`, …) and its own runtime messages
 * (`reconnecting`, `timed out waiting for child process`).
 */
export const CODEX_RULES: readonly MatcherRule[] = [
  {
    pattern: /OPENAI_API_KEY|set your OPENAI_API_KEY/i,
    reason: 'auth_required',
    hint: 'Set OPENAI_API_KEY in Settings → Agent → Codex.',
  },
  {
    pattern: /insufficient_quota|exceeded your current quota/i,
    reason: 'quota_exceeded',
    hint: 'Add credit to your OpenAI account or switch provider.',
  },
  {
    pattern: /invalid_api_key|incorrect_api_key/i,
    reason: 'auth_required',
  },
  {
    pattern: /model_not_found|invalid model/i,
    reason: 'model_unavailable',
  },
  // ── Codex runtime: reconnect storm or watchdog ──
  {
    pattern: /reconnecting/i,
    reason: 'retry',
  },
  {
    pattern: /timeout waiting for child process/i,
    reason: 'retry',
  },
  // ── OpenAI surface of context overflow ──
  {
    pattern: /maximum context length is \d+ tokens/i,
    reason: 'compress_context',
  },
  {
    pattern: /context_length_exceeded/i,
    reason: 'compress_context',
  },
  {
    pattern: /tokens?.{0,16}exceed(s|ed)? the model.s context/i,
    reason: 'compress_context',
  },
];
