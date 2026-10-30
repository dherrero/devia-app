import type { NormalizedEvent, StreamParser } from '../../../../../../shared/domain/normalized-event';
import { BoundedLineBuffer } from '../bounded-line-buffer';

/**
 * Normalized parser for the `json-event-stream` format used by Codex,
 * OpenCode, Gemini, and similar agents that emit newline-delimited JSON
 * objects following a thread/turn/item lifecycle.
 *
 * The parser is instantiated per run; it holds no global state.
 */

interface JsonStreamEvent {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    status?: string;
    changes?: unknown;
  };
  error?: { message?: string } | string;
  message?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
  [k: string]: unknown;
}

const PROTOCOL_VERSION = 1;

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function extractErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value['message'] === 'string') return value['message'];
  return fallback;
}

export function createJsonEventStreamNormalizedParser(providerId: string): StreamParser {
  const buf = new BoundedLineBuffer();
  let desyncced = false;
  let started = false;
  const knownToolUses = new Set<string>();

  function ensureStarted(out: NormalizedEvent[]): void {
    if (!started) {
      out.push({ kind: 'stream_start', protocolVersion: PROTOCOL_VERSION });
      started = true;
    }
  }

  function parseLine(line: string): NormalizedEvent[] {
    let obj: JsonStreamEvent;
    try {
      obj = JSON.parse(line) as JsonStreamEvent;
    } catch {
      desyncced = true;
      return [{ kind: 'error', code: 'PARSER_DESYNC', message: 'Malformed JSON line', recoverable: false, raw: line }];
    }

    const type = obj.type;
    const out: NormalizedEvent[] = [];
    ensureStarted(out);

    switch (type) {
      case 'thread.started':
        out.push({ kind: 'status', label: 'initializing' });
        break;

      case 'turn.started':
        out.push({ kind: 'status', label: 'running' });
        break;

      case 'item.started': {
        if (isRecord(obj.item) && obj.item.type === 'command_execution' && typeof obj.item.id === 'string') {
          const id = obj.item.id;
          if (!knownToolUses.has(id)) {
            knownToolUses.add(id);
            out.push({
              kind: 'tool_call',
              toolId: id,
              name: 'Bash',
              input: { command: typeof obj.item.command === 'string' ? obj.item.command : '' },
            });
          }
        }
        break;
      }

      case 'item.completed': {
        if (!isRecord(obj.item)) break;
        const item = obj.item;

        if (item.type === 'command_execution' && typeof item.id === 'string') {
          const id = item.id;
          if (!knownToolUses.has(id)) {
            knownToolUses.add(id);
            out.push({
              kind: 'tool_call',
              toolId: id,
              name: 'Bash',
              input: { command: typeof item.command === 'string' ? item.command : '' },
            });
          }
          out.push({
            kind: 'tool_result',
            toolId: id,
            content: stringifyContent(item.aggregated_output ?? ''),
            isError: typeof item.exit_code === 'number' ? item.exit_code !== 0 : item.status === 'failed',
          });
        } else if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.length > 0) {
          out.push({ kind: 'text_delta', text: item.text });
        } else if (item.type === 'file_change' && typeof item.id === 'string') {
          const id = item.id;
          if (!knownToolUses.has(id)) {
            knownToolUses.add(id);
            out.push({
              kind: 'tool_call',
              toolId: id,
              name: 'Edit',
              input: { changes: item.changes ?? [] },
            });
          }
          out.push({
            kind: 'tool_result',
            toolId: id,
            content: stringifyContent(item.changes ?? []),
            isError: false,
          });
        }
        break;
      }

      case 'turn.completed': {
        if (isRecord(obj.usage)) {
          const u = obj.usage;
          const usageEvent: NormalizedEvent = { kind: 'usage' };
          if (typeof u['input_tokens'] === 'number') (usageEvent as { kind: 'usage'; inputTokens?: number }).inputTokens = u['input_tokens'] as number;
          if (typeof u['output_tokens'] === 'number') (usageEvent as { kind: 'usage'; outputTokens?: number }).outputTokens = u['output_tokens'] as number;
          out.push(usageEvent);
        }
        out.push({ kind: 'turn_end', reason: 'end' });
        break;
      }

      case 'turn.failed':
        out.push({
          kind: 'error',
          code: 'AGENT_ERROR',
          message: extractErrorMessage(obj.error ?? obj.message, 'Turn failed'),
          recoverable: false,
        });
        break;

      case 'error':
        out.push({
          kind: 'error',
          code: 'AGENT_ERROR',
          message: extractErrorMessage(obj.message ?? obj.error, 'Agent error'),
          recoverable: false,
        });
        break;

      default:
        // Unknown event — ignore silently (AC5)
        break;
    }

    return out;
  }

  return {
    providerId,

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
      const out: NormalizedEvent[] = [];
      if (tail) {
        const parsed = parseLine(tail);
        out.push(...parsed);
      } else if (!started) {
        ensureStarted(out);
      }
      if (!out.some((e) => e.kind === 'stream_end')) {
        out.push({ kind: 'stream_end', reason: 'completed' });
      }
      return out;
    },
  };
}
