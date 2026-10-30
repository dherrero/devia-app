import type { AgentEventSink, StreamParser } from '../../domain/stream-parser';
import { LineBuffer } from './line-buffer';

/**
 * Fallback parser for CLIs whose `streamFormat` is `'plain'`. We wrap
 * every non-empty line as a `text_delta` event so the renderer displays
 * it like any other agent reply (with a trailing newline so lines don't
 * fuse together).
 */
export function createPlainTextParser(sink: AgentEventSink): StreamParser {
  const buf = new LineBuffer();
  return {
    feed(chunk: string) {
      for (const line of buf.push(chunk)) sink({ type: 'text_delta', delta: line + '\n' });
    },
    flush() {
      const tail = buf.drain();
      if (tail) sink({ type: 'text_delta', delta: tail + '\n' });
    },
  };
}
