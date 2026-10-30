import type { AgentEvent, AgentEventSink, StreamParser } from '../../cli-adapters/domain/stream-parser';
import type { OpencodeEvent, OpencodePart } from './wire';
import { LineBuffer } from '../../cli-adapters/infrastructure/parsers/line-buffer';
import { isRecord, safeParseJson, stringifyContent, extractErrorMessage } from '../../cli-adapters/infrastructure/parsers/json-util';

/**
 * Translator for OpenCode CLI's `run --format json` stream.
 *
 * OpenCode 1.x wraps every event in a `part` envelope and uses a
 * step-based protocol with tool calls keyed by `callID`. Shape:
 *
 *   { type: 'step_start',  part: { ... }, sessionID }
 *   { type: 'text',        part: { text: '...' } }
 *   { type: 'tool_use',    part: { type: 'tool', tool: 'skill',
 *                                  callID: 'call_...', state: { status, input, output } } }
 *   { type: 'step_finish', part: { tokens: { input, output, reasoning, cache:{read,write} },
 *                                  cost } }
 *   { type: 'error',       message | error }
 *
 * The same `callID` appears once with `state.status === 'pending'`/`'running'`
 * (we emit `tool_use`) and again with `state.status === 'completed'`
 * (we emit `tool_result`). We de-dupe `tool_use` per session+callID so a
 * pending → running → completed sequence does not produce duplicate
 * tool_use events in the UI.
 *
 * Logic mirrors the reference Open Design daemon's `handleOpenCodeEvent`
 * (re-implemented from event-shape knowledge, no code copied). Wire shapes
 * are typed in `./wire.ts`.
 */

export function createOpencodeEventStreamParser(sink: AgentEventSink): StreamParser {
  const buf = new LineBuffer();
  const seenToolUses = new Set<string>();
  // S-30 T-351: every event carries its `sessionID`; the first one is the
  // native resume handle (`opencode run --session <id>`).
  let sessionAnnounced = false;

  function handle(line: string): void {
    let obj: OpencodeEvent;
    try { obj = JSON.parse(line) as OpencodeEvent; } catch {
      sink({ type: 'raw', line });
      return;
    }
    const part: OpencodePart = isRecord(obj.part) ? obj.part : {};
    if (!sessionAnnounced && typeof obj.sessionID === 'string' && obj.sessionID.length > 0) {
      sessionAnnounced = true;
      sink({ type: 'session_started', agentSessionId: obj.sessionID });
    }

    // ── Step lifecycle ─────────────────────────────────────────────────────
    if (obj.type === 'step_start') {
      // T-7: step_start may carry model at the top level when OpenCode reports it.
      const model = typeof obj['model'] === 'string' ? obj['model'] : undefined;
      const status: AgentEvent = { type: 'status', label: 'running' };
      if (model !== undefined) status.model = model;
      sink(status);
      return;
    }

    // ── Assistant text ─────────────────────────────────────────────────────
    if (obj.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      sink({ type: 'text_delta', delta: part.text });
      return;
    }

    // ── Tool use + tool result (same callID, status-discriminated) ─────────
    // UC-FIX-013: sessionID is required for dedupe. A missing or empty
    // sessionID means we cannot form a unique key — emit raw and skip so
    // stale/concurrent runs never coalesce into the same dedupe set.
    if (obj.type === 'tool_use'
      && typeof part.tool === 'string'
      && typeof part.callID === 'string') {
      if (!obj.sessionID) {
        console.warn('[opencode-parser] tool_use frame missing sessionID — emitting as raw');
        sink({ type: 'raw', line });
        return;
      }
      const statePart = isRecord(part.state) ? part.state : null;
      const key = `${obj.sessionID}:${part.callID}`;
      if (!seenToolUses.has(key)) {
        seenToolUses.add(key);
        sink({
          type: 'tool_use',
          id: part.callID,
          name: part.tool,
          input: safeParseJson(statePart?.input) ?? statePart?.input ?? null,
        });
      }
      if (statePart?.status === 'completed') {
        sink({
          type: 'tool_result',
          toolUseId: part.callID,
          content: stringifyContent(statePart.output),
          isError: false,
        });
      }
      return;
    }

    // ── Step finish — emit usage ───────────────────────────────────────────
    if (obj.type === 'step_finish') {
      const tokens = part.tokens;
      if (tokens) {
        const ev: {
          type: 'usage';
          inputTokens?: number;
          outputTokens?: number;
          cachedInputTokens?: number;
          reasoningOutputTokens?: number;
          costUsd?: number;
        } = { type: 'usage' };
        if (typeof tokens.input === 'number') ev.inputTokens = tokens.input;
        if (typeof tokens.output === 'number') ev.outputTokens = tokens.output;
        if (typeof tokens.reasoning === 'number') ev.reasoningOutputTokens = tokens.reasoning;
        const cacheRead = isRecord(tokens.cache) ? tokens.cache['read'] : undefined;
        if (typeof cacheRead === 'number') ev.cachedInputTokens = cacheRead;
        if (typeof part.cost === 'number') ev.costUsd = part.cost;
        if (ev.inputTokens !== undefined || ev.outputTokens !== undefined || ev.costUsd !== undefined) {
          sink(ev);
        }
      }
      return;
    }

    // ── Error frames ──────────────────────────────────────────────────────
    // OpenCode emits structured error frames on stdout (provider auth
    // failures, schema mismatches, …) and still exits 0. Surface them as
    // proper `error` events so the run flips to `failed` and the user sees
    // a visible message in the chat — previously these were swallowed as
    // `raw` and the run looked like a fast clean success with no reply.
    if (obj.type === 'error') {
      const message = extractErrorMessage(obj.error ?? obj.message, 'OpenCode error');
      sink({ type: 'error', message, classification: 'unknown' });
      return;
    }

    // ── Unknown events — emit raw so nothing is silently dropped ──────────
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
