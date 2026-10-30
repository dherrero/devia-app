import type { NormalizedEvent, StreamParser } from '../../../../../../shared/domain/normalized-event';
import { BoundedLineBuffer } from '../bounded-line-buffer';

// ── Minimal wire-shape types ──────────────────────────────────────────────────

interface MessageStartEvent {
  type: 'message_start';
  message: {
    id?: string;
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block:
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
}

interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'thinking_delta'; thinking: string }
    | { type: 'input_json_delta'; partial_json: string };
}

interface MessageDeltaEvent {
  type: 'message_delta';
  delta: { stop_reason?: string; stop_sequence?: string | null };
  usage?: { output_tokens?: number };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = 1;

function mapStopReason(raw: string | undefined): NormalizedEvent & { kind: 'turn_end' } {
  let reason: 'end' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'other';
  switch (raw) {
    case 'end_turn': reason = 'end'; break;
    case 'tool_use': reason = 'tool_use'; break;
    case 'max_tokens': reason = 'max_tokens'; break;
    case 'stop_sequence': reason = 'stop_sequence'; break;
    default: reason = 'other';
  }
  return { kind: 'turn_end', reason };
}

// ── Parser ────────────────────────────────────────────────────────────────────

export function createClaudeStreamNormalizedParser(): StreamParser {
  const buf = new BoundedLineBuffer();

  let started = false;
  let desyncced = false;
  let storedInputTokens: number | undefined;

  // Per-block state keyed by content-block index
  const blockKind = new Map<number, 'text' | 'thinking' | 'tool_use'>();
  const toolId = new Map<number, string>();
  const toolName = new Map<number, string>();
  const toolInputBuf = new Map<number, string>();

  function parseLine(line: string): NormalizedEvent[] {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      desyncced = true;
      return [{ kind: 'error', code: 'PARSER_DESYNC', message: 'Malformed JSON line', recoverable: false, raw: line }];
    }

    const evType = typeof raw['type'] === 'string' ? raw['type'] : '';
    const out: NormalizedEvent[] = [];

    switch (evType) {
      case 'message_start': {
        const ev = raw as unknown as MessageStartEvent;
        const model = ev.message?.model;
        const sessionId: string | undefined = undefined;
        out.push({ kind: 'stream_start', protocolVersion: PROTOCOL_VERSION, ...(model ? { model } : {}), ...(sessionId ? { sessionId } : {}) });
        started = true;
        const inputTokens = ev.message?.usage?.input_tokens;
        if (typeof inputTokens === 'number') {
          storedInputTokens = inputTokens;
          out.push({ kind: 'usage', inputTokens });
        }
        blockKind.clear(); toolId.clear(); toolName.clear(); toolInputBuf.clear();
        break;
      }

      case 'content_block_start': {
        const ev = raw as unknown as ContentBlockStartEvent;
        const cb = ev.content_block;
        if (!cb) break;
        if (cb.type === 'text') {
          blockKind.set(ev.index, 'text');
        } else if (cb.type === 'thinking') {
          blockKind.set(ev.index, 'thinking');
          out.push({ kind: 'thinking_start' });
        } else if (cb.type === 'tool_use') {
          blockKind.set(ev.index, 'tool_use');
          toolId.set(ev.index, cb.id);
          toolName.set(ev.index, cb.name);
          toolInputBuf.set(ev.index, '');
        }
        break;
      }

      case 'content_block_delta': {
        const ev = raw as unknown as ContentBlockDeltaEvent;
        const delta = ev.delta;
        if (!delta) break;
        if (delta.type === 'text_delta' && delta.text) {
          out.push({ kind: 'text_delta', text: delta.text });
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          out.push({ kind: 'thinking_delta', text: delta.thinking });
        } else if (delta.type === 'input_json_delta') {
          const prev = toolInputBuf.get(ev.index) ?? '';
          toolInputBuf.set(ev.index, prev + (delta.partial_json ?? ''));
        }
        break;
      }

      case 'content_block_stop': {
        const index = typeof raw['index'] === 'number' ? raw['index'] : -1;
        const kind = blockKind.get(index);
        if (kind === 'thinking') {
          out.push({ kind: 'thinking_end' });
          blockKind.delete(index);
        } else if (kind === 'tool_use') {
          const id = toolId.get(index) ?? `tool-${index}`;
          const name = toolName.get(index) ?? 'unknown';
          const jsonStr = toolInputBuf.get(index) ?? '';
          let input: unknown = {};
          try { input = jsonStr ? (JSON.parse(jsonStr) as unknown) : {}; } catch { input = { _raw: jsonStr }; }
          out.push({ kind: 'tool_call', toolId: id, name, input });
          blockKind.delete(index);
          toolId.delete(index);
          toolName.delete(index);
          toolInputBuf.delete(index);
        }
        break;
      }

      case 'message_delta': {
        const ev = raw as unknown as MessageDeltaEvent;
        out.push(mapStopReason(ev.delta?.stop_reason));
        const outputTokens = ev.usage?.output_tokens;
        if (outputTokens !== undefined) {
          const usageEvent: NormalizedEvent = {
            kind: 'usage',
            outputTokens,
            ...(storedInputTokens !== undefined ? { inputTokens: storedInputTokens } : {}),
          };
          out.push(usageEvent);
        }
        break;
      }

      case 'message_stop':
        // turn_end already emitted by message_delta
        break;

      case 'result': {
        // Claude Code wrapper: may carry session_id on success
        const sessionId = typeof raw['session_id'] === 'string' && raw['session_id'].length > 0
          ? raw['session_id']
          : undefined;
        if (sessionId) {
          // Re-emit stream_start with sessionId so consumers can store it
          out.push({ kind: 'stream_start', protocolVersion: PROTOCOL_VERSION, sessionId });
        }
        if (raw['is_error'] === true) {
          const msg = typeof raw['result'] === 'string' ? raw['result'] : 'Agent error';
          out.push({ kind: 'error', code: 'AGENT_ERROR', message: msg, recoverable: false });
        }
        out.push({ kind: 'stream_end', reason: raw['is_error'] === true ? 'aborted' : 'completed' });
        break;
      }

      case 'system':
      case 'user':
      case 'assistant':
        // Not renderer-relevant; skip silently for forward compat
        break;

      default:
        // Unknown event type — ignore silently for forward compatibility (AC5)
        break;
    }

    return out;
  }

  return {
    providerId: 'claude',

    feed(chunk: Uint8Array | string): NormalizedEvent[] {
      if (desyncced) return [];
      const str = chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : chunk;
      const { lines, overflow } = buf.push(str);
      if (overflow) {
        desyncced = true;
        return [{ kind: 'error', code: 'PARSER_OVERFLOW', message: 'Line buffer capacity exceeded', recoverable: false }];
      }
      const events: NormalizedEvent[] = [];
      for (const line of lines) {
        if (desyncced) break;
        const parsed = parseLine(line);
        events.push(...parsed);
        // Stop accepting input after a desync error
        if (parsed.some((e) => e.kind === 'error' && e.code === 'PARSER_DESYNC')) {
          desyncced = true;
          break;
        }
      }
      return events;
    },

    flush(): NormalizedEvent[] {
      if (desyncced) return [];
      const tail = buf.drain();
      if (!tail) {
        if (started) return [{ kind: 'stream_end', reason: 'completed' }];
        return [];
      }
      const out = parseLine(tail);
      if (!out.some((e) => e.kind === 'stream_end') && !out.some((e) => e.kind === 'error' && !e.recoverable)) {
        out.push({ kind: 'stream_end', reason: 'completed' });
      }
      return out;
    },
  };
}
