/**
 * GitHub Copilot CLI event stream parser (standalone `copilot --output-format
 * json`). Copilot emits JSONL — one JSON object per line — with dotted
 * top-level `type`s (`session.*`, `assistant.*`, `tool.*`, `result`) and the
 * payload under `data`. Each recognised event maps onto the shared
 * `AgentEvent` union; ephemeral/unmapped events (mcp status, skills_loaded,
 * reasoning recap, turn boundaries) have no UI lane and are dropped.
 *
 * Mapping:
 *   session.tools_updated      -> status (initializing, with model)
 *   assistant.turn_start       -> status (streaming)
 *   assistant.reasoning_delta  -> thinking_delta
 *   assistant.message_delta    -> text_delta
 *   tool.execution_start       -> tool_use
 *   tool.execution_complete    -> tool_result
 *   result                     -> usage + turn_end
 */

import type { AgentEvent, AgentEventSink } from '../../../../../shared/domain/agent-event';
import type { StreamParser } from '../../domain/stream-parser';
import { LineBuffer } from './line-buffer';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringifyResult(r: unknown): string {
  if (r === null || r === undefined) return '';
  if (typeof r === 'string') return r;
  if (!isRecord(r)) return JSON.stringify(r);
  if (typeof r['content'] === 'string') return r['content'];
  if (typeof r['detailedContent'] === 'string') return r['detailedContent'];
  return JSON.stringify(r);
}

export function createCopilotEventStreamParser(sink: AgentEventSink): StreamParser {
  const buf = new LineBuffer();

  function feedLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let obj: unknown;
    try { obj = JSON.parse(trimmed); }
    catch { sink({ type: 'raw', line: trimmed }); return; }
    handleObject(obj, trimmed);
  }

  function handleObject(obj: unknown, raw: string): void {
    if (!isRecord(obj) || typeof obj['type'] !== 'string') {
      sink({ type: 'raw', line: raw });
      return;
    }
    const data = isRecord(obj['data']) ? obj['data'] : {};

    switch (obj['type']) {
      case 'session.tools_updated': {
        const model = typeof data['model'] === 'string' ? data['model'] : undefined;
        const status: AgentEvent = { type: 'status', label: 'initializing' };
        if (model !== undefined) status.model = model;
        sink(status);
        return;
      }
      case 'assistant.turn_start':
        sink({ type: 'status', label: 'streaming' });
        return;
      case 'assistant.reasoning_delta': {
        const delta = typeof data['deltaContent'] === 'string' ? data['deltaContent'] : '';
        if (delta.length > 0) sink({ type: 'thinking_delta', delta });
        return;
      }
      case 'assistant.message_delta': {
        const delta = typeof data['deltaContent'] === 'string' ? data['deltaContent'] : '';
        if (delta.length > 0) sink({ type: 'text_delta', delta });
        return;
      }
      case 'tool.execution_start': {
        const id = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : '';
        const name = typeof data['toolName'] === 'string' ? data['toolName'] : '';
        if (id && name) sink({ type: 'tool_use', id, name, input: data['arguments'] ?? {} });
        else sink({ type: 'raw', line: raw });
        return;
      }
      case 'tool.execution_complete': {
        const id = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : '';
        if (id) {
          sink({
            type: 'tool_result',
            toolUseId: id,
            content: stringifyResult(data['result']),
            isError: data['success'] === false,
          });
        } else {
          sink({ type: 'raw', line: raw });
        }
        return;
      }
      case 'result': {
        const usage = isRecord(obj['usage']) ? obj['usage'] : null;
        if (usage) {
          const e: AgentEvent = { type: 'usage' };
          const inTok = usage['input_tokens'] ?? usage['inputTokens'] ?? usage['prompt_tokens'];
          const outTok = usage['output_tokens'] ?? usage['outputTokens'] ?? usage['completion_tokens'];
          if (typeof inTok === 'number') e.inputTokens = inTok;
          if (typeof outTok === 'number') e.outputTokens = outTok;
          sink(e);
        }
        const ok = obj['success'] === true || obj['exitCode'] === 0;
        sink({ type: 'turn_end', stopReason: ok ? 'completed' : 'error' });
        return;
      }
      default:
        // Ephemeral / unmapped Copilot events have no UI lane — drop silently.
        return;
    }
  }

  return {
    feed(chunk: string) { for (const line of buf.push(chunk)) feedLine(line); },
    flush() { const tail = buf.drain(); if (tail !== null) feedLine(tail); },
  };
}
