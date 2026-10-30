import { describe, it, expect } from 'vitest';
import { classify, classifyReason } from '../error-classifier';
import type { FailoverReason } from '../../../../../shared/domain/cli-errors';

/**
 * Table-driven coverage of the error classifier — one row per
 * representative error string per CLI, plus generic-fallback rows. The
 * goal is breadth (every FailoverReason is exercised) rather than depth
 * (every regex variant); per-rule regex behaviour belongs in the rules
 * themselves.
 *
 * Adding a new pattern: drop a row here first. Red → add the matcher →
 * green.
 */

interface Case {
  cli: string;
  input: string;
  expected: FailoverReason;
  /** Optional substring expected on the `hint` field. Omitted when the
   *  matcher does not carry a hint. */
  hint?: string;
  /** Expected `retryAfterSeconds` value when the matcher should parse one. */
  retryAfter?: number;
}

const cases: Case[] = [
  // ── Claude ────────────────────────────────────────────────────────────
  { cli: 'claude', input: 'Error: not logged in. Run `claude login`.', expected: 'auth_required', hint: 'claude login' },
  { cli: 'claude', input: 'anthropic 401 invalid_api_key', expected: 'auth_required' },
  { cli: 'claude', input: 'anthropic 529 overloaded_error', expected: 'retry' },
  { cli: 'claude', input: 'messages.0.content.0.image.source.base64: image exceeds 5 MB maximum', expected: 'compress_context', hint: 'Shrink' },
  { cli: 'claude', input: 'prompt is too long: 220000 tokens exceed maximum 200000', expected: 'compress_context' },
  { cli: 'claude', input: 'long-context tier required for this request', expected: 'quota_exceeded' },
  { cli: 'claude', input: 'thinking block signature was modified', expected: 'retry' },
  { cli: 'claude', input: 'OAuth long-context beta forbidden for subscription tier', expected: 'model_unavailable' },
  { cli: 'claude', input: 'agent_prompt_too_large: 1200000 bytes', expected: 'compress_context' },
  // T-88: enterprise-managed MCP config (both abort messages)
  { cli: 'claude', input: 'You cannot use --strict-mcp-config when an enterprise MCP config is present', expected: 'unrecoverable', hint: 'organization manages' },
  { cli: 'claude', input: 'You cannot dynamically configure MCP servers when an enterprise MCP config is present', expected: 'unrecoverable', hint: 'DEVIA_ASSUME_ENTERPRISE_MCP' },

  // ── Codex ─────────────────────────────────────────────────────────────
  { cli: 'codex', input: 'Please set your OPENAI_API_KEY env var', expected: 'auth_required', hint: 'OPENAI_API_KEY' },
  { cli: 'codex', input: 'error: invalid_api_key', expected: 'auth_required' },
  { cli: 'codex', input: 'insufficient_quota: please add billing details', expected: 'quota_exceeded' },
  { cli: 'codex', input: 'model_not_found: gpt-4-vision-preview was deprecated', expected: 'model_unavailable' },
  { cli: 'codex', input: 'reconnecting to stream after disconnect', expected: 'retry' },
  { cli: 'codex', input: "this model's maximum context length is 128000 tokens", expected: 'compress_context' },
  { cli: 'codex', input: 'context_length_exceeded for request', expected: 'compress_context' },
  { cli: 'codex', input: 'timeout waiting for child process', expected: 'retry' },

  // ── Gemini ────────────────────────────────────────────────────────────
  { cli: 'gemini', input: 'Please set GEMINI_API_KEY in your environment', expected: 'auth_required', hint: 'GEMINI_API_KEY' },
  { cli: 'gemini', input: 'PERMISSION_DENIED: caller does not have permission', expected: 'auth_required' },
  { cli: 'gemini', input: 'UNAUTHENTICATED: API key not valid', expected: 'auth_required' },
  { cli: 'gemini', input: 'RESOURCE_EXHAUSTED: quota exceeded for project', expected: 'rate_limited' },
  { cli: 'gemini', input: 'billing not enabled on this project', expected: 'quota_exceeded' },
  { cli: 'gemini', input: 'token count 1500000 exceeds maximum 1048576', expected: 'compress_context' },
  { cli: 'gemini', input: 'DEADLINE_EXCEEDED for upstream call', expected: 'retry' },

  // ── OpenCode ──────────────────────────────────────────────────────────
  { cli: 'opencode', input: 'no provider configured for default agent', expected: 'auth_required', hint: 'opencode.json' },
  { cli: 'opencode', input: 'OpenRouter: No endpoints available matching your data policy', expected: 'model_unavailable', hint: 'privacy' },
  { cli: 'opencode', input: 'ollama not running at http://localhost:11434', expected: 'retry', hint: 'ollama' },
  { cli: 'opencode', input: 'json-schema-to-grammar: regex escape not supported', expected: 'retry' },

  // ── Cursor agent ──────────────────────────────────────────────────────
  { cli: 'cursor-agent', input: 'You are not logged in. Please run cursor-login', expected: 'auth_required', hint: 'cursor-agent login' },
  { cli: 'cursor-agent', input: 'session expired, refresh token rejected', expected: 'rotate_credential' },
  { cli: 'cursor-agent', input: 'Cursor usage limit reached for this month', expected: 'quota_exceeded' },
  { cli: 'cursor-agent', input: 'Pro plan required for advanced models', expected: 'quota_exceeded' },

  // ── Copilot ───────────────────────────────────────────────────────────
  { cli: 'copilot', input: 'Run gh auth login to authenticate', expected: 'auth_required', hint: 'gh auth' },
  { cli: 'copilot', input: 'GitHub Copilot subscription required', expected: 'quota_exceeded' },
  { cli: 'copilot', input: 'Copilot not enabled for your organization', expected: 'auth_required' },
  { cli: 'copilot', input: 'github API rate limit reached', expected: 'rate_limited' },

  // ── Qwen ──────────────────────────────────────────────────────────────
  { cli: 'qwen', input: 'DASHSCOPE_API_KEY is not set', expected: 'auth_required', hint: 'DASHSCOPE_API_KEY' },
  { cli: 'qwen', input: 'InvalidApiKey: signature mismatch', expected: 'auth_required' },
  { cli: 'qwen', input: '账户余额不足，请充值', expected: 'quota_exceeded' },
  { cli: 'qwen', input: '请求超过最大长度', expected: 'compress_context' },
  { cli: 'qwen', input: 'Throttling.User: rate increased too quickly', expected: 'rate_limited' },

  // ── DeepSeek ─────────────────────────────────────────────────────────
  { cli: 'deepseek', input: 'DEEPSEEK_API_KEY missing', expected: 'auth_required', hint: 'DEEPSEEK_API_KEY' },
  { cli: 'deepseek', input: 'deepseek: invalid token rejected by upstream', expected: 'auth_required' },
  { cli: 'deepseek', input: 'deepseek: insufficient balance, top up', expected: 'quota_exceeded' },
  { cli: 'deepseek', input: 'deepseek-chat model not available in your region', expected: 'model_unavailable' },

  // ── Qoder ────────────────────────────────────────────────────────────
  { cli: 'qoder', input: 'qoder: login required, session expired', expected: 'auth_required', hint: 'qoder login' },
  { cli: 'qoder', input: 'qoder: monthly quota reached', expected: 'quota_exceeded' },

  // ── Generic fallback (unknown CLI) ───────────────────────────────────
  { cli: 'agent12', input: 'HTTP 429: too many requests, please retry after 30 seconds', expected: 'rate_limited', retryAfter: 30 },
  { cli: 'agent12', input: 'HTTP 503: service unavailable', expected: 'retry' },
  { cli: 'agent12', input: 'context length 200001 > maximum 200000', expected: 'compress_context' },
  { cli: 'agent12', input: 'something nobody has ever seen before', expected: 'unrecoverable' },
  { cli: 'agent12', input: '', expected: 'unrecoverable' },
];

describe('classify (per-CLI table)', () => {
  for (const c of cases) {
    const label = `${c.cli}: "${c.input.slice(0, 60)}${c.input.length > 60 ? '…' : ''}"`;
    it(`→ ${c.expected} — ${label}`, () => {
      const result = classify(c.cli, c.input);
      expect(result.reason).toBe(c.expected);
      expect(result.cliId).toBe(c.cli);
      expect(result.rawMessage).toBe(c.input);
      if (c.hint) expect(result.hint).toMatch(new RegExp(c.hint, 'i'));
      if (c.retryAfter !== undefined) expect(result.retryAfterSeconds).toBe(c.retryAfter);
    });
  }
});

describe('classify regressions', () => {
  it('never throws on weird inputs', () => {
    expect(() => classify('claude', String.fromCharCode(0, 1, 2))).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => classify('claude', null as any)).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => classify('claude', undefined as any)).not.toThrow();
  });

  it('returns unrecoverable for unrecognised CLI + unrecognised message', () => {
    const r = classify('definitely-not-a-cli', 'foo bar baz');
    expect(r.reason).toBe('unrecoverable');
    expect(r.cliId).toBe('definitely-not-a-cli');
  });

  it('classifyReason matches classify().reason', () => {
    const sample = 'HTTP 429 too many requests';
    expect(classifyReason('claude', sample)).toBe(classify('claude', sample).reason);
  });

  it('parses Anthropic-style retry-after seconds', () => {
    const r = classify('claude', 'Rate limit reached. Please retry after 12 seconds.');
    expect(r.reason).toBe('rate_limited');
    expect(r.retryAfterSeconds).toBe(12);
  });

  it('parses minute-based retry hints', () => {
    const r = classify('codex', 'You are being rate limited. Try again in 2 min.');
    expect(r.reason).toBe('rate_limited');
    expect(r.retryAfterSeconds).toBe(120);
  });
});
