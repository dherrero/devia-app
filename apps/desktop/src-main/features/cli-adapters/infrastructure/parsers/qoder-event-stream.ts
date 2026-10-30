/**
 * Qoder CLI event stream parser (`qodercli -p --output-format stream-json`).
 *
 * Qoder is a Claude-Code-flavoured CLI: its JSONL records are wrapper objects
 * (`system`/init, `assistant` with a `message.content[]` block list, optional
 * `user` tool_result messages, and a final `result`) — close to Claude's
 * stream-json but with adapter-specific fields, so it gets its own parser.
 * Each record maps onto the shared `AgentEvent` union.
 */

import type { AgentEvent, AgentEventSink } from '../../../../../shared/domain/agent-event';
import type { StreamParser } from '../../domain/stream-parser';
import { LineBuffer } from './line-buffer';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function errorMessageFromResult(obj: Record<string, unknown>): string {
  if (typeof obj['error'] === 'string' && obj['error'].length > 0) return obj['error'];
  if (isRecord(obj['error']) && typeof obj['error']['message'] === 'string') {
    return obj['error']['message'];
  }
  if (typeof obj['message'] === 'string' && obj['message'].length > 0) return obj['message'];
  if (typeof obj['stop_reason'] === 'string' && obj['stop_reason'].length > 0) {
    return `Qoder run failed: ${obj['stop_reason']}`;
  }
  return 'Qoder run failed';
}

export function createQoderEventStreamParser(sink: AgentEventSink): StreamParser {
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
    if (!isRecord(obj)) { sink({ type: 'raw', line: raw }); return; }

    // system / init → status (+ session id for resume).
    if (obj['type'] === 'system' && obj['subtype'] === 'init') {
      const status: AgentEvent = { type: 'status', label: 'initializing' };
      if (typeof obj['model'] === 'string') status.model = obj['model'];
      sink(status);
      if (typeof obj['session_id'] === 'string' && obj['session_id'].length > 0) {
        sink({ type: 'session_started', agentSessionId: obj['session_id'] });
      }
      return;
    }

    // assistant message → text / thinking / tool_use blocks.
    if (obj['type'] === 'assistant' && isRecord(obj['message'])) {
      const message = obj['message'];
      const content = message['content'];
      if (typeof content === 'string') {
        if (content.length > 0) sink({ type: 'text_delta', delta: content });
        return;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block['type'] === 'text' && typeof block['text'] === 'string') {
            if (block['text'].length > 0) sink({ type: 'text_delta', delta: block['text'] });
          } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
            if (block['thinking'].length > 0) sink({ type: 'thinking_delta', delta: block['thinking'] });
          } else if (block['type'] === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string') {
            sink({ type: 'tool_use', id: block['id'], name: block['name'], input: block['input'] ?? {} });
          }
        }
      }
      return;
    }

    // user message → tool_result blocks (Claude-style).
    if (obj['type'] === 'user' && isRecord(obj['message'])) {
      const content = obj['message']['content'];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isRecord(block) && block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
            sink({
              type: 'tool_result',
              toolUseId: block['tool_use_id'],
              content: asString(block['content']),
              isError: block['is_error'] === true,
            });
          }
        }
      }
      return;
    }

    // final result → usage + turn_end (+ error when is_error).
    if (obj['type'] === 'result') {
      const isError = obj['is_error'] === true;
      const usage = isRecord(obj['usage']) ? obj['usage'] : null;
      const e: AgentEvent = { type: 'usage' };
      if (usage) {
        const inTok = usage['input_tokens'];
        const outTok = usage['output_tokens'];
        if (typeof inTok === 'number') e.inputTokens = inTok;
        if (typeof outTok === 'number') e.outputTokens = outTok;
      }
      if (typeof obj['total_cost_usd'] === 'number') e.costUsd = obj['total_cost_usd'];
      sink(e);
      if (isError) {
        sink({ type: 'error', message: errorMessageFromResult(obj) });
      }
      const stopReason = typeof obj['stop_reason'] === 'string' ? obj['stop_reason'] : (isError ? 'error' : 'done');
      sink({ type: 'turn_end', stopReason });
      return;
    }

    sink({ type: 'raw', line: raw });
  }

  return {
    feed(chunk: string) { for (const line of buf.push(chunk)) feedLine(line); },
    flush() { const tail = buf.drain(); if (tail !== null) feedLine(tail); },
  };
}
