/**
 * Tests for the Qoder JSONL event stream parser (Claude-flavoured wrapper
 * objects: system/init, assistant message blocks, user tool_result, result).
 */
import { describe, it, expect } from 'vitest';
import { createQoderEventStreamParser } from './qoder-event-stream';
import type { AgentEvent } from '../../../../../shared/domain/agent-event';

function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}
function feed(lines: string[]): AgentEvent[] {
  const events: AgentEvent[] = [];
  const parser = createQoderEventStreamParser((e) => events.push(e));
  for (const l of lines) parser.feed(l);
  parser.flush();
  return events;
}

describe('qoder JSONL event stream parser', () => {
  it('system/init → status + session_started', () => {
    const events = feed([line({ type: 'system', subtype: 'init', model: 'auto', session_id: 'sess-1' })]);
    expect(events).toEqual([
      { type: 'status', label: 'initializing', model: 'auto' },
      { type: 'session_started', agentSessionId: 'sess-1' },
    ]);
  });

  it('assistant text + thinking + tool_use blocks', () => {
    const events = feed([
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Hello' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    ]);
    expect(events).toEqual([
      { type: 'thinking_delta', delta: 'hmm' },
      { type: 'text_delta', delta: 'Hello' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('user tool_result block → tool_result', () => {
    const events = feed([
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done', is_error: false }] } }),
    ]);
    expect(events).toEqual([{ type: 'tool_result', toolUseId: 't1', content: 'done', isError: false }]);
  });

  it('result → usage (tokens + cost) and turn_end', () => {
    const events = feed([
      line({ type: 'result', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01, stop_reason: 'end_turn', is_error: false }),
    ]);
    expect(events).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      { type: 'turn_end', stopReason: 'end_turn' },
    ]);
  });

  it('result with is_error → usage, error, turn_end', () => {
    const events = feed([line({ type: 'result', is_error: true, error: 'boom' })]);
    expect(events).toEqual([
      { type: 'usage' },
      { type: 'error', message: 'boom' },
      { type: 'turn_end', stopReason: 'error' },
    ]);
  });

  it('falls back to raw for malformed JSON', () => {
    expect(feed(['not-json\n'])).toEqual([{ type: 'raw', line: 'not-json' }]);
  });
});
