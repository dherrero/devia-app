/**
 * Canonical event union emitted by every stream parser.
 *
 * Uses `kind` (not `type`) to distinguish itself from the IPC-wire
 * `AgentEvent` union. Consumers (orchestrator, renderer, persistence)
 * read only this shape; they must never inspect a vendor's raw JSON.
 *
 * Parsers lower each vendor protocol to this union via the `StreamParser`
 * interface below. No code outside a provider parser module is allowed to
 * depend on vendor-specific event shapes.
 */
export type NormalizedEvent =
  | { kind: 'stream_start'; protocolVersion: number; model?: string; sessionId?: string }
  | { kind: 'status'; label: string; detail?: string; ttftMs?: number }
  | { kind: 'text_delta'; text: string }
  | { kind: 'thinking_start' }
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'thinking_end' }
  | { kind: 'tool_call'; toolId: string; name: string; input: unknown; requiresHostAnswer?: boolean }
  | { kind: 'tool_result'; toolId: string; content: string; isError: boolean }
  | { kind: 'file_change_hint'; path: string; op: 'create' | 'update' | 'delete' }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number }
  | { kind: 'turn_end'; reason: 'end' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'other' }
  | { kind: 'error'; code: string; message: string; recoverable: boolean; raw?: string }
  | { kind: 'stream_end'; reason: 'completed' | 'aborted' };

/**
 * Interface every parser module implements.
 *
 * - `feed` accepts raw bytes or a string chunk and returns all normalized
 *   events that could be assembled from the data received so far.
 * - `flush` is called once when the underlying stream closes; it drains
 *   any partial frame still in the buffer and returns remaining events.
 *
 * Parsers must be pure: no global state, no I/O, no side effects.
 * A malformed frame must produce `{ kind:'error', code:'PARSER_DESYNC' }`
 * rather than throwing.
 */
export interface StreamParser {
  readonly providerId: string;
  feed(chunk: Uint8Array | string): NormalizedEvent[];
  flush(): NormalizedEvent[];
}

/**
 * Describes one recorded stream used as a golden test fixture.
 */
export interface ParserFixture {
  name: string;
  inputs: Array<{ chunk: string; delayMs?: number }>;
  expected: NormalizedEvent[];
}
