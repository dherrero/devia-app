/**
 * Typed wire DTOs for `gemini --output-format stream-json` (S-19 F1.1).
 *
 * NOT a strict discriminated union on purpose: the Gemini CLI stream schema has
 * drifted across builds, so the parser accepts several shapes rather than pin
 * to one. The current verified shape (cross-checked against the reference
 * open-design daemon `handleGeminiEvent` and recent Gemini CLI builds) is:
 *
 *   { type: 'init',        model }
 *   { type: 'message',     role: 'user' | 'assistant', content }
 *   { type: 'tool_use',    tool_id, tool_name, parameters }
 *   { type: 'tool_result', tool_id, status, output, error }
 *   { type: 'error',       severity, message | error }
 *   { type: 'result',      status, stats: { input_tokens, output_tokens, cached, duration_ms }, error }
 *
 * Legacy / alternate fields kept for older builds: `event`, `text`, `delta`,
 * `content`, `toolCall`, `functionCall`, `tool`.
 */

export interface GeminiResultStats {
  input_tokens?: number;
  output_tokens?: number;
  cached?: number;
  duration_ms?: number;
}

/** Legacy tool-call envelope (older builds: `toolCall` / `functionCall`). */
export interface GeminiToolRef {
  name?: string;
  id?: string;
  args?: unknown;
}

export interface GeminiStreamEvent {
  type?: string;
  /** Legacy discriminator alias for `type`. */
  event?: string;
  role?: string;

  // Text-bearing fields (build-dependent).
  text?: string;
  delta?: string;
  content?: string;
  model?: string;

  // Verified tool shape.
  tool_id?: string;
  tool_name?: string;
  parameters?: unknown;
  status?: string;
  output?: unknown;
  error?: unknown;

  // Error / result shape.
  severity?: string;
  message?: unknown;
  stats?: GeminiResultStats;

  // Legacy tool shapes.
  toolCall?: GeminiToolRef;
  functionCall?: GeminiToolRef;
  tool?: { name?: string };

  [k: string]: unknown;
}
