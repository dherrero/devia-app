/**
 * Contract C for pi (S-30): the `pi --mode rpc` JSONL dialect, verified against
 * pi 1.3.0 and its bundled docs (`rpc.md`, `rpc-commands.md`, `json.md`,
 * `rpc-extension-ui.md` in `@earendil-works/pi-coding-agent`), and against the
 * recorded fixtures in `__fixtures__/`.
 *
 * Framing: one JSON object per LF-terminated line, in both directions. Split on
 * LF only — Node's `readline` also splits on U+2028/U+2029, which are valid
 * inside JSON strings. Only the fields Devia uses are typed.
 */

// ── stdin: commands ──────────────────────────────────────────────────────────

export interface PiImageContent {
  type: 'image';
  /** base64 */
  data: string;
  mimeType: string;
}

export type PiCommand =
  | { id?: string | number; type: 'prompt'; message: string; images?: PiImageContent[]; streamingBehavior?: 'steer' | 'followUp' }
  | { id?: string | number; type: 'get_state' }
  | { id?: string | number; type: 'abort' };

/** The answer to a dialog an extension raised (no `response` comes back). */
export type PiExtensionUiResponse =
  | { type: 'extension_ui_response'; id: string | number; value: string }
  | { type: 'extension_ui_response'; id: string | number; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string | number; cancelled: true };

// ── stdout: responses ────────────────────────────────────────────────────────

export interface PiResponse<T = unknown> {
  type: 'response';
  id?: string | number;
  command: string;
  success: boolean;
  error?: string;
  data?: T;
}

/** `get_state` data — the session id is what makes native resume possible. */
export interface PiState {
  sessionId?: string;
  sessionFile?: string;
  model?: { id?: string; provider?: string; contextWindow?: number };
  isStreaming?: boolean;
}

// ── stdout: session events ───────────────────────────────────────────────────

export interface PiUsage {
  /** Excludes cache (Anthropic's split). */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

export type PiAssistantMessageEvent =
  | { type: 'text_delta'; contentIndex?: number; delta: string }
  | { type: 'thinking_delta'; contentIndex?: number; delta: string }
  | { type: 'toolcall_start'; id: string; toolName: string }
  | { type: 'error'; reason?: string }
  | { type: string };

export type PiEvent =
  | { type: 'agent_start' }
  /** One low-level run ended — retries / compaction / queued work may follow. */
  | { type: 'agent_end'; willRetry?: boolean }
  /** Final: pi will not continue automatically. The Devia turn ends HERE. */
  | { type: 'agent_settled'; aborted: boolean }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message?: { usage?: PiUsage; stopReason?: string; errorMessage?: string } }
  | { type: 'message_update'; usage?: PiUsage; assistantMessageEvent: PiAssistantMessageEvent }
  /** `toolName` is `mcp__<server>__<tool>` for MCP tools, server sanitised to `[A-Za-z0-9_]`. */
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args?: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName?: string; result?: { content?: unknown }; isError?: boolean }
  | { type: 'compaction_start'; reason?: 'manual' | 'threshold' | 'overflow' }
  | { type: 'compaction_end'; reason?: string; result?: { tokensBefore?: number }; aborted?: boolean; errorMessage?: string }
  | { type: 'auto_retry_start' }
  | { type: 'auto_retry_end'; success: boolean; finalError?: string }
  | { type: 'extension_error'; error?: string };

/** A dialog (or notification) an extension raised; fields are top-level. */
export interface PiExtensionUiRequest {
  type: 'extension_ui_request';
  id: string | number;
  method: 'select' | 'confirm' | 'input' | 'editor' | 'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text' | string;
  title?: string;
  message?: string;
  options?: unknown[];
  placeholder?: string;
  timeout?: number;
}
