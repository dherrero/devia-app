import type { AgentEvent, AgentEventSink, StreamParser } from '../../domain/stream-parser';
import type { GeminiStreamEvent } from './wire/gemini-wire';
import { LineBuffer } from './line-buffer';
import { isRecord, safeParseJson, stringifyContent, extractErrorMessage } from './json-util';

/**
 * Translator for `gemini --output-format stream-json`. Each line is a
 * JSON object; we emit typed `AgentEvent` objects.
 *
 * Maps the verified Gemini CLI shape (init / message / tool_use / tool_result
 * / error / result) while still accepting older/alternate shapes (text, delta,
 * content, toolCall, functionCall, tool). Wire shapes are typed in
 * `./wire/gemini-wire.ts`; logic mirrors the reference open-design daemon's
 * `handleGeminiEvent` (re-implemented, no code copied).
 */

function pickText(obj: GeminiStreamEvent): string {
  if (typeof obj.delta === 'string') return obj.delta;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.content === 'string') return obj.content;
  return '';
}

function pickToolInfo(obj: GeminiStreamEvent): { name: string; id: string; input: unknown } | null {
  // Verified shape: { type: 'tool_use', tool_name, tool_id, parameters }.
  if (typeof obj.tool_name === 'string') {
    // Gemini's native todo tool maps onto Devia's TodoWrite renderer.
    const name = obj.tool_name === 'write_todos' ? 'TodoWrite' : obj.tool_name;
    return {
      name,
      id: typeof obj.tool_id === 'string' ? obj.tool_id : `gemini-tool-${Date.now()}`,
      input: safeParseJson(obj.parameters) ?? obj.parameters ?? {},
    };
  }
  if (obj.toolCall) {
    return {
      name: typeof obj.toolCall.name === 'string' ? obj.toolCall.name : 'unknown',
      id: typeof obj.toolCall.id === 'string' ? obj.toolCall.id : `gemini-tool-${Date.now()}`,
      input: obj.toolCall.args ?? {},
    };
  }
  if (obj.functionCall) {
    return {
      name: typeof obj.functionCall.name === 'string' ? obj.functionCall.name : 'unknown',
      id: typeof obj.functionCall.id === 'string' ? obj.functionCall.id : `gemini-fn-${Date.now()}`,
      input: obj.functionCall.args ?? {},
    };
  }
  if (obj.tool) {
    return {
      name: typeof obj.tool.name === 'string' ? obj.tool.name : 'unknown',
      id: `gemini-tool-${Date.now()}`,
      input: {},
    };
  }
  return null;
}

function usageFromStats(obj: GeminiStreamEvent): AgentEvent | null {
  const stats = obj.stats;
  if (!stats) return null;
  const ev: Extract<AgentEvent, { type: 'usage' }> = { type: 'usage' };
  if (typeof stats.input_tokens === 'number') ev.inputTokens = stats.input_tokens;
  if (typeof stats.output_tokens === 'number') ev.outputTokens = stats.output_tokens;
  if (typeof stats.cached === 'number') ev.cachedInputTokens = stats.cached;
  if (typeof stats.duration_ms === 'number') ev.durationMs = stats.duration_ms;
  const hasAny = ev.inputTokens !== undefined || ev.outputTokens !== undefined
    || ev.cachedInputTokens !== undefined || ev.durationMs !== undefined;
  return hasAny ? ev : null;
}

export function createGeminiEventStreamParser(sink: AgentEventSink): StreamParser {
  const buf = new LineBuffer();

  function handle(line: string): void {
    let obj: GeminiStreamEvent;
    try { obj = JSON.parse(line) as GeminiStreamEvent; } catch { return; }
    const kind = String(obj.type ?? obj.event ?? '').toLowerCase();

    // ── Model info / initializing ───────────────────────────────────────────
    if (kind === 'init' || kind === 'start' || kind === 'model') {
      const model = typeof obj.model === 'string' ? obj.model : undefined;
      sink({ type: 'status', label: 'initializing', ...(model !== undefined ? { model } : {}) });
      return;
    }

    // ── Assistant / user message (verified shape) ───────────────────────────
    if (kind === 'message') {
      // Never echo the user's own prompt back into the transcript.
      if (obj.role === 'user') return;
      const text = pickText(obj);
      if (text) sink({ type: 'text_delta', delta: text });
      return;
    }

    // ── Tool result (verified shape) ────────────────────────────────────────
    if (kind === 'tool_result' && typeof obj.tool_id === 'string') {
      const errRec = isRecord(obj.error) ? obj.error : null;
      const errMsg = errRec ? extractErrorMessage(errRec, '') : '';
      const content = typeof obj.output === 'string'
        ? obj.output
        : (errMsg || stringifyContent(obj.output));
      sink({
        type: 'tool_result',
        toolUseId: obj.tool_id,
        content,
        isError: obj.status === 'error' || Boolean(errRec),
      });
      return;
    }

    // ── Tool / function call ────────────────────────────────────────────────
    if (kind.includes('tool') || kind.includes('function')) {
      const info = pickToolInfo(obj);
      if (info) {
        sink({ type: 'tool_use', id: info.id, name: info.name, input: info.input });
        return;
      }
      // Fall through to text extraction if no tool info found.
    }

    // ── Error frames ────────────────────────────────────────────────────────
    // Previously swallowed as `raw`, so a failed Gemini run looked like a fast
    // clean success with no reply. A `warning` severity is non-fatal — surface
    // it as a status rather than flipping the run to failed.
    if (kind === 'error') {
      const severity = typeof obj.severity === 'string' ? obj.severity.toLowerCase() : '';
      if (severity === 'warning') {
        sink({ type: 'status', label: 'warning' });
      } else {
        const message = extractErrorMessage(obj.message ?? obj.error, 'Gemini CLI error');
        sink({ type: 'error', message, classification: 'unknown' });
      }
      return;
    }

    // ── Final result — usage stats, or a terminal error ─────────────────────
    if (kind === 'result') {
      if (obj.status === 'error' || isRecord(obj.error)) {
        const message = extractErrorMessage(obj.error, 'Gemini CLI error');
        sink({ type: 'error', message, classification: 'unknown' });
        return;
      }
      const usage = usageFromStats(obj);
      if (usage) sink(usage);
      return;
    }

    // ── Text delta (legacy / alternate shapes) ──────────────────────────────
    const text = pickText(obj);
    if (text) {
      sink({ type: 'text_delta', delta: text });
      return;
    }

    // ── Unknown / metadata — emit raw ───────────────────────────────────────
    sink({ type: 'raw', line });
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
