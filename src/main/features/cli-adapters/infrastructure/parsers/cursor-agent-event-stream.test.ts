/**
 * REV-AGENT-CORE-008: tests for the cursor-agent event-stream parser.
 */
import { describe, it, expect } from 'vitest';
import { createCursorAgentEventStreamParser } from './cursor-agent-event-stream';
import type { AgentEvent } from '../../../../../shared/domain/agent-event';

function feed(lines: string[]): AgentEvent[] {
  const events: AgentEvent[] = [];
  const parser = createCursorAgentEventStreamParser(e => events.push(e));
  for (const line of lines) parser.feed(line + '\n');
  parser.flush();
  return events;
}

describe('cursor-agent event stream parser', () => {
  it('emits status with model on message_start', () => {
    const events = feed([JSON.stringify({ type: 'message_start', model: 'cursor-fast' })]);
    expect(events).toEqual([{ type: 'status', label: 'initializing', model: 'cursor-fast' }]);
  });

  it('emits text_delta from direct delta events', () => {
    const events = feed([
      JSON.stringify({ type: 'text_delta', delta: 'Hello, ' }),
      JSON.stringify({ type: 'text_delta', delta: 'world' }),
    ]);
    expect(events).toEqual([
      { type: 'text_delta', delta: 'Hello, ' },
      { type: 'text_delta', delta: 'world' },
    ]);
  });

  it('rolling text: emits only the new suffix when payloads are cumulative', () => {
    const events = feed([
      JSON.stringify({ type: 'text', text: 'Hello, ' }),
      JSON.stringify({ type: 'text', text: 'Hello, world' }),
      JSON.stringify({ type: 'text', text: 'Hello, world!' }),
    ]);
    expect(events).toEqual([
      { type: 'text_delta', delta: 'Hello, ' },
      { type: 'text_delta', delta: 'world' },
      { type: 'text_delta', delta: '!' },
    ]);
  });

  it('emits tool_use with id/name/input', () => {
    const events = feed([
      JSON.stringify({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }),
    ]);
    expect(events).toEqual([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('emits tool_result with the isError flag', () => {
    const events = feed([
      JSON.stringify({ type: 'tool_result', tool_use_id: 't1', content: 'out', is_error: false }),
    ]);
    expect(events).toEqual([
      { type: 'tool_result', toolUseId: 't1', content: 'out', isError: false },
    ]);
  });

  it('emits usage with input/output tokens', () => {
    const events = feed([
      JSON.stringify({ type: 'usage', input_tokens: 100, output_tokens: 50 }),
    ]);
    expect(events).toEqual([
      { type: 'usage', inputTokens: 100, outputTokens: 50 },
    ]);
  });

  it('emits turn_end with stop_reason', () => {
    const events = feed([
      JSON.stringify({ type: 'message_stop', stop_reason: 'end_turn' }),
    ]);
    expect(events).toEqual([{ type: 'turn_end', stopReason: 'end_turn' }]);
  });

  it('emits error with message', () => {
    const events = feed([JSON.stringify({ type: 'error', message: 'rate limited' })]);
    expect(events).toEqual([{ type: 'error', message: 'rate limited' }]);
  });

  it('falls back to raw for unrecognised event types', () => {
    const events = feed(['{"type":"made_up_event","payload":1}']);
    expect(events).toEqual([{ type: 'raw', line: '{"type":"made_up_event","payload":1}' }]);
  });

  it('falls back to raw for malformed JSON', () => {
    const events = feed(['not even json']);
    expect(events).toEqual([{ type: 'raw', line: 'not even json' }]);
  });
});
