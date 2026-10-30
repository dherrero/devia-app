/**
 * Typed wire DTOs for OpenCode CLI's `run --format json` stream (S-19 F1.1).
 *
 * OpenCode 1.x wraps every event in a `part` envelope and uses a step-based
 * protocol with tool calls keyed by `callID`. Verified against the reference
 * open-design daemon `handleOpenCodeEvent` and OpenCode 1.14.x output:
 *
 *   { type: 'step_start',  part: { ... }, sessionID }
 *   { type: 'text',        part: { text } }
 *   { type: 'tool_use',    part: { tool, callID, state: { status, input, output } }, sessionID }
 *   { type: 'step_finish', part: { tokens: { input, output, reasoning, cache: { read, write } }, cost } }
 *   { type: 'error',       message | error }
 */

export interface OpencodeToolState {
  status?: string;
  input?: unknown;
  output?: unknown;
}

export interface OpencodeTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface OpencodePart {
  type?: string;
  tool?: string;
  callID?: string;
  text?: string;
  state?: OpencodeToolState;
  tokens?: OpencodeTokens;
  cost?: number;
  [k: string]: unknown;
}

export interface OpencodeEvent {
  type?: string;
  sessionID?: string;
  part?: OpencodePart;
  message?: string;
  error?: unknown;
  [k: string]: unknown;
}
