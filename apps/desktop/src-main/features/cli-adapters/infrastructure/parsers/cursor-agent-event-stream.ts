/**
 * Cursor-agent JSON-event stream parser (REV-AGENT-CORE-008).
 *
 * Cursor-agent emits JSONL events on stdout. The exact shape varies by CLI
 * version; this parser handles the documented shapes and falls through to
 * `raw` for anything it does not recognise — so an upstream change never
 * silently drops a turn:
 *
 *   {"type": "message_start", "model": "..."}
 *   {"type": "text_delta",    "text":  "..."}       // also seen as "delta"
 *   {"type": "tool_use",      "id": "...", "name": "...", "input": {...}}
 *   {"type": "tool_result",   "tool_use_id": "...", "content": "...", "is_error": false}
 *   {"type": "usage",         "input_tokens": N, "output_tokens": M}
 *   {"type": "message_stop",  "stop_reason": "..."}
 *   {"type": "error",         "message": "..."}
 *
 * Cursor uses a "rolling text" pattern in some versions: a series of
 * `text` events where each carries the full text so far. We detect this by
 * comparing each text against the cumulative buffer and only emit the *new*
 * suffix, mirroring TR1 in the story.
 */

import type { AgentEvent, AgentEventSink } from '../../../../../shared/domain/agent-event';
import type { StreamParser } from '../../domain/stream-parser';
import { LineBuffer } from './line-buffer';

export function createCursorAgentEventStreamParser(sink: AgentEventSink): StreamParser {
  const buf = new LineBuffer();
  let textSoFar = '';

  function emitTextDelta(next: string): void {
    if (!next) return;
    // Rolling text dedup: if the new payload starts with what we've already
    // emitted, send only the suffix.
    if (next.startsWith(textSoFar)) {
      const suffix = next.slice(textSoFar.length);
      if (suffix.length > 0) {
        textSoFar = next;
        sink({ type: 'text_delta', delta: suffix });
      }
    } else {
      // Disjoint reset (rare) — emit verbatim and update buffer.
      textSoFar = next;
      sink({ type: 'text_delta', delta: next });
    }
  }

  function feedLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed) as Record<string, unknown>; }
    catch { sink({ type: 'raw', line: trimmed }); return; }

    const type = typeof obj['type'] === 'string' ? obj['type'] : '';
    switch (type) {
      case 'message_start': {
        const model = typeof obj['model'] === 'string' ? obj['model'] : undefined;
        const status: AgentEvent = { type: 'status', label: 'initializing' };
        if (model !== undefined) status.model = model;
        sink(status);
        return;
      }
      case 'text':
      case 'text_delta':
      case 'delta': {
        // Either incremental delta or rolling cumulative text.
        const text =
          typeof obj['text'] === 'string' ? obj['text'] :
          typeof obj['delta'] === 'string' ? obj['delta'] :
          '';
        if (typeof obj['delta'] === 'string' && type === 'text_delta') {
          // Direct delta — append.
          textSoFar += obj['delta'];
          sink({ type: 'text_delta', delta: obj['delta'] });
        } else if (text.length > 0) {
          emitTextDelta(text);
        }
        return;
      }
      case 'tool_use': {
        const id    = typeof obj['id'] === 'string' ? obj['id'] : '';
        const name  = typeof obj['name'] === 'string' ? obj['name'] : '';
        const input = obj['input'] ?? {};
        if (id && name) sink({ type: 'tool_use', id, name, input });
        else sink({ type: 'raw', line: trimmed });
        return;
      }
      case 'tool_result': {
        const id      = typeof obj['tool_use_id'] === 'string' ? obj['tool_use_id'] : '';
        const content = typeof obj['content'] === 'string' ? obj['content'] : JSON.stringify(obj['content'] ?? '');
        const isError = obj['is_error'] === true;
        if (id) sink({ type: 'tool_result', toolUseId: id, content, isError });
        else sink({ type: 'raw', line: trimmed });
        return;
      }
      case 'usage': {
        const e: AgentEvent = { type: 'usage' };
        if (typeof obj['input_tokens']  === 'number') e.inputTokens  = obj['input_tokens'];
        if (typeof obj['output_tokens'] === 'number') e.outputTokens = obj['output_tokens'];
        sink(e);
        return;
      }
      case 'message_stop':
      case 'turn_end': {
        const stopReason = typeof obj['stop_reason'] === 'string' ? obj['stop_reason'] : 'end_turn';
        sink({ type: 'turn_end', stopReason });
        return;
      }
      case 'error': {
        const message = typeof obj['message'] === 'string' ? obj['message'] : 'Unknown cursor-agent error';
        sink({ type: 'error', message });
        return;
      }
      default:
        sink({ type: 'raw', line: trimmed });
        return;
    }
  }

  return {
    feed(chunk: string) { for (const line of buf.push(chunk)) feedLine(line); },
    flush() { const tail = buf.drain(); if (tail !== null) feedLine(tail); },
  };
}
