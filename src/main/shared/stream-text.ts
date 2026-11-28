/**
 * Accumulate the assistant's reply text from the run's event stream (E-DSK-14).
 *
 * The runner emits one serialised {@link AgentEvent} per line (cli-launcher
 * `onOutput`), the same shape for every adapter. The assistant's prose arrives
 * as a sequence of `text_delta` chunks, so we APPEND each delta to rebuild the
 * full reply. Everything else (status, thinking, tool_use/tool_result, usage,
 * turn_end, …) carries no displayable answer and is ignored.
 */
interface AgentEventLine {
  type?: string;
  delta?: string;
}

/**
 * Fold a stream line into the running assistant text. Returns the new value
 * (`prev` + delta for a `text_delta`, `prev` unchanged otherwise). Malformed or
 * non-JSON lines are ignored.
 */
export function foldAssistantText(line: string, prev: string): string {
  let event: AgentEventLine;
  try {
    event = JSON.parse(line) as AgentEventLine;
  } catch {
    return prev;
  }
  if (event.type === 'text_delta' && typeof event.delta === 'string') {
    return prev + event.delta;
  }
  return prev;
}
