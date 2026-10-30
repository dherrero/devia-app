import type { AgentEvent, AgentEventSink } from '../../../../shared/domain/agent-event';

/**
 * Common interface every CLI-specific stream parser implements. The
 * launcher feeds raw stdout chunks via `feed()` and calls `flush()` on
 * child-close to drain any trailing buffered line. The parser is free
 * to emit zero, one, or many `onEvent` callbacks per feed.
 *
 * All parsers emit typed `AgentEvent` objects. The IPC transport
 * serialises each event with `JSON.stringify` before sending it over
 * the `claude:output` channel; the renderer deserialises with
 * `JSON.parse` and switches on `event.type`.
 */
export type { AgentEvent, AgentEventSink };

export interface StreamParser {
  feed(chunk: string): void;
  flush(): void;
}

export type StreamParserFactory = (sink: AgentEventSink) => StreamParser;
