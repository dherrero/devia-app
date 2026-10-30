import type { MatcherRule } from './shared';

/**
 * Claude Code CLI-specific error patterns.
 *
 * Captures the strings Claude Code emits before falling through to the
 * generic provider rules. Most patterns are sourced from hermes'
 * Anthropic adapter classifications; a few are Claude Code (CLI) specific.
 */
export const CLAUDE_RULES: readonly MatcherRule[] = [
  // ── Claude Code CLI: enterprise-managed MCP config (T-88) ──
  // Safety net for the case proactive detection misses (non-standard managed
  // path): surface an actionable hint instead of a cryptic abort. Covers both
  // the --strict-mcp-config rejection AND the broader "cannot dynamically
  // configure MCP servers" (which also blocks --mcp-config) under enterprise.
  {
    pattern: /enterprise mcp config is present|(--strict-mcp-config|dynamically configure mcp servers).*enterprise/i,
    reason: 'unrecoverable',
    hint: "Your organization manages Claude's MCP config — servers can't be added per-invocation. Set DEVIA_ASSUME_ENTERPRISE_MCP=1 so Devia skips them, or ask IT to add Devia's servers to the enterprise config.",
  },
  // ── Claude Code CLI: not logged in ──
  {
    pattern: /not logged in|run\s+`?claude\s+login`?/i,
    reason: 'auth_required',
    hint: 'Run `claude login` (or set ANTHROPIC_API_KEY in Settings).',
  },
  // ── Anthropic: subscription / OAuth limits ──
  {
    pattern: /oauth.*long.?context.*beta.*(forbidden|denied)/i,
    reason: 'model_unavailable',
    hint: 'OAuth subscription does not include the 1M context beta — disable it in Settings.',
  },
  {
    pattern: /thinking.*signature/i,
    reason: 'retry',
  },
  // ── Anthropic: per-image 5 MB limit ──
  {
    pattern: /image exceeds 5\s?MB/i,
    reason: 'compress_context',
    hint: 'Shrink the attached image — Anthropic limits each image to 5 MB.',
  },
  // ── Anthropic: usage tiering ──
  {
    pattern: /long.?context.*tier|extra usage tier/i,
    reason: 'quota_exceeded',
    hint: 'Your Anthropic plan does not include the long-context tier.',
  },
  // ── Standard Anthropic API errors carried in stderr ──
  {
    pattern: /anthropic[^\n]{0,40}(401|invalid_api_key)/i,
    reason: 'auth_required',
  },
  {
    pattern: /anthropic[^\n]{0,40}(529|overloaded_error)/i,
    reason: 'retry',
  },
  {
    pattern: /prompt is too long/i,
    reason: 'compress_context',
  },
  {
    pattern: /agent_prompt_too_large/i,
    reason: 'compress_context',
  },
];
