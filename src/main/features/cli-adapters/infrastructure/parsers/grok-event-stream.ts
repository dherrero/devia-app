import type { AgentEvent, AgentEventSink, StreamParser } from '../../domain/stream-parser';
import { LineBuffer } from './line-buffer';
import { isRecord, safeParseJson, stringifyContent } from './json-util';

/**
 * Translator for grok-dev's headless `--format json` output. Each line is a
 * JSON event (verified against grok-dev `src/headless/output.ts`):
 *   - `step_start`  — structural, ignored.
 *   - `text`        — assistant text for the step → `text_delta`.
 *   - `tool_use`    — combined `{ toolCall, toolResult }` → emits BOTH a
 *                     `tool_use` and a `tool_result` AgentEvent.
 *   - `step_finish` — `{ usage: { inputTokens, outputTokens, ... } }` → `usage`.
 *   - `error`       — `{ message }` → `error`.
 * Every line may carry `sessionID`; the first one becomes `session_started`,
 * which the use case stores as `agentSessionId` for `--session <id>` resume.
 *
 * Tolerant: a non-JSON line (e.g. an older `grok` ignoring `--format json`, or a
 * stray log) is surfaced as assistant text instead of being dropped, so a run
 * never silently looks empty.
 */

interface GrokToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}
interface GrokEvent {
  type?: unknown;
  sessionID?: unknown;
  text?: unknown;
  toolCall?: GrokToolCall;
  toolResult?: unknown;
  usage?: { inputTokens?: unknown; outputTokens?: unknown } | undefined;
  message?: unknown;
}

export function createGrokEventStreamParser(sink: AgentEventSink): StreamParser {
  const buf = new LineBuffer();
  let sessionEmitted = false;

  function handle(line: string): void {
    const parsed = safeParseJson(line);
    if (!isRecord(parsed)) {
      if (line.trim()) sink({ type: 'text_delta', delta: line });
      return;
    }
    const obj = parsed as GrokEvent;

    // Capture the native session id once → enables `--session <id>` resume.
    if (!sessionEmitted && typeof obj.sessionID === 'string' && obj.sessionID) {
      sink({ type: 'session_started', agentSessionId: obj.sessionID });
      sessionEmitted = true;
    }

    switch (obj.type) {
      case 'text': {
        if (typeof obj.text === 'string' && obj.text) sink({ type: 'text_delta', delta: obj.text });
        return;
      }
      case 'tool_use': {
        const call = obj.toolCall;
        const id = call && typeof call.id === 'string' && call.id ? call.id : `grok-tool-${Date.now()}`;
        const name = call?.function && typeof call.function.name === 'string' ? call.function.name : 'tool';
        const input = call?.function
          ? (safeParseJson(call.function.arguments) ?? call.function.arguments ?? {})
          : {};
        sink({ type: 'tool_use', id, name, input });

        const res = obj.toolResult;
        if (isRecord(res)) {
          const isError = res['success'] === false;
          const content = typeof res['output'] === 'string' && res['output']
            ? res['output']
            : (typeof res['error'] === 'string' && res['error']
                ? res['error']
                : stringifyContent(res['output']));
          sink({ type: 'tool_result', toolUseId: id, content, isError });
        }
        return;
      }
      case 'step_finish': {
        const u = obj.usage;
        if (u && typeof u === 'object') {
          const ev: Extract<AgentEvent, { type: 'usage' }> = { type: 'usage' };
          if (typeof u.inputTokens === 'number') ev.inputTokens = u.inputTokens;
          if (typeof u.outputTokens === 'number') ev.outputTokens = u.outputTokens;
          if (ev.inputTokens !== undefined || ev.outputTokens !== undefined) sink(ev);
        }
        return;
      }
      case 'error': {
        const message = typeof obj.message === 'string' && obj.message ? obj.message : 'Grok CLI error';
        sink({ type: 'error', message, classification: 'unknown' });
        return;
      }
      // step_start / unknown — structural, nothing to emit.
      default:
        return;
    }
  }

  return {
    feed(chunk: string) {
      for (const line of buf.push(chunk)) handle(line);
    },
    flush() {
      const tail = buf.drain();
      if (tail) handle(tail);
    },
  };
}
