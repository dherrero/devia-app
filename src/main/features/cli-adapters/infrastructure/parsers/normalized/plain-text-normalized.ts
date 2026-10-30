import type { NormalizedEvent, StreamParser } from '../../../../../../shared/domain/normalized-event';
import { BoundedLineBuffer } from '../bounded-line-buffer';

const PROTOCOL_VERSION = 1;

/**
 * Normalized parser for agents that emit plain text on stdout (Qwen,
 * DeepSeek, Qoder, and any future text-only adapter). Every non-empty line
 * becomes a `text_delta` event. The parser never desyncs because there is
 * no structured format to violate.
 */
export function createPlainTextNormalizedParser(providerId: string): StreamParser {
  const buf = new BoundedLineBuffer();
  let started = false;

  return {
    providerId,

    feed(chunk: Uint8Array | string): NormalizedEvent[] {
      const str = chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : chunk;
      const { lines, overflow } = buf.push(str);

      if (overflow) {
        return [{ kind: 'error', code: 'PARSER_OVERFLOW', message: 'Line buffer capacity exceeded', recoverable: false }];
      }

      const out: NormalizedEvent[] = [];
      if (!started && lines.length > 0) {
        out.push({ kind: 'stream_start', protocolVersion: PROTOCOL_VERSION });
        started = true;
      }
      for (const line of lines) {
        out.push({ kind: 'text_delta', text: line });
      }
      return out;
    },

    flush(): NormalizedEvent[] {
      const tail = buf.drain();
      const out: NormalizedEvent[] = [];
      if (!started) {
        out.push({ kind: 'stream_start', protocolVersion: PROTOCOL_VERSION });
        started = true;
      }
      if (tail) {
        out.push({ kind: 'text_delta', text: tail });
      }
      out.push({ kind: 'stream_end', reason: 'completed' });
      return out;
    },
  };
}
