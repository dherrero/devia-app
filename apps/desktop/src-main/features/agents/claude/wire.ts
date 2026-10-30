/**
 * Contract C for Claude Code (S-30): the JSONL shapes Devia reads from
 * `claude -p --output-format stream-json --verbose --include-partial-messages`
 * and writes to its `--input-format stream-json` stdin. Derived from the
 * decoder and checked against the recorded fixtures in `__fixtures__/`
 * (Claude Code 2.1.x).
 *
 * Only the fields Devia consumes are typed; everything else is tolerated.
 */
export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block:
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
}

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'thinking_delta'; thinking: string }
    | { type: 'input_json_delta'; partial_json: string };
}

export interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Per-request breakdown Claude Code attaches to the `result` usage. */
  iterations?: UsageBlock[];
}

export interface MessageStartEvent {
  type: 'message_start';
  message: {
    id: string;
    model: string;
    usage?: UsageBlock;
  };
}

export interface MessageDeltaEvent {
  type: 'message_delta';
  delta: { stop_reason: string; stop_sequence?: string | null };
  usage?: UsageBlock;
}

/** Any stdout line: the SDK stream events (wrapped in `stream_event` or bare),
 *  and Claude Code's own `system` / `assistant` / `user` / `result` records. */
export interface StreamJsonLine {
  type?: string;
  [k: string]: unknown;
}

/** `system` / `init` — first line of every run: session id, model, tools, MCP status. */
export interface SystemInitLine {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
}

/** `result` — last line: totals for the run (`usage` is a SUM over requests). */
export interface ResultLine {
  type: 'result';
  subtype: string;
  session_id?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: UsageBlock;
  modelUsage?: Record<string, { contextWindow?: number }>;
}

/** `rate_limit_event` — subscription-window state. `resetsAt` is epoch SECONDS.
 *  Only `status` and `resetsAt` are relied on; a hit limit reports `rejected`. */
export interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
}

export interface RateLimitEventLine {
  type: 'rate_limit_event';
  rate_limit_info?: RateLimitInfo;
}

/** The synthetic assistant message Claude Code writes when the account limit is
 *  hit (recorded in real sessions, Claude Code 2.1.302). Only what Devia reads. */
export interface AssistantLimitLine {
  type: 'assistant';
  error?: string;
  apiError?: string;
  apiErrorParams?: { rate_limit_info?: RateLimitInfo };
  quotaLimits?: RateLimitInfo;
  message?: { content?: Array<{ type?: string; text?: string }> };
}

// ── stdin (`--input-format stream-json`) ────────────────────────────────────

/** A user turn. */
export interface UserMessageInput {
  type: 'user';
  message: { role: 'user'; content: Array<{ type: 'text'; text: string } | ToolResultBlock> };
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
}

/** The answer to a tool_use, injected mid-turn. */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}
