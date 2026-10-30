import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '../../domain/stream-parser';
import { createGrokEventStreamParser } from './grok-event-stream';

function collect(lines: string[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  const p = createGrokEventStreamParser((e) => out.push(e));
  for (const l of lines) p.feed(l + '\n');
  p.flush();
  return out;
}

describe('createGrokEventStreamParser (S-21)', () => {
  it('emits session_started once, text, tool_use + tool_result, usage', () => {
    const events = collect([
      JSON.stringify({ type: 'step_start', sessionID: 'sess1', stepNumber: 0, timestamp: 1 }),
      JSON.stringify({ type: 'text', sessionID: 'sess1', stepNumber: 0, text: 'Hola', timestamp: 2 }),
      JSON.stringify({
        type: 'tool_use', sessionID: 'sess1', stepNumber: 0, timestamp: 3,
        toolCall: { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
        toolResult: { success: true, output: 'file.txt' },
      }),
      JSON.stringify({
        type: 'step_finish', sessionID: 'sess1', stepNumber: 0, timestamp: 4,
        finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    ]);

    expect(events.filter((e) => e.type === 'session_started')).toHaveLength(1);
    expect(events.find((e) => e.type === 'session_started')).toMatchObject({ agentSessionId: 'sess1' });
    expect(events.find((e) => e.type === 'text_delta')).toMatchObject({ delta: 'Hola' });
    expect(events.find((e) => e.type === 'tool_use')).toMatchObject({ id: 'c1', name: 'bash', input: { command: 'ls' } });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ toolUseId: 'c1', content: 'file.txt', isError: false });
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it('maps a failed tool result to isError with the error text', () => {
    const events = collect([
      JSON.stringify({
        type: 'tool_use',
        toolCall: { id: 'c2', function: { name: 'bash', arguments: '{}' } },
        toolResult: { success: false, error: 'boom' },
      }),
    ]);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ toolUseId: 'c2', content: 'boom', isError: true });
  });

  it('surfaces error frames', () => {
    const events = collect([JSON.stringify({ type: 'error', message: 'rate limited' })]);
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'rate limited' });
  });

  it('tolerates non-JSON output as assistant text (older grok / stray line)', () => {
    const events = collect(['plain line of output']);
    expect(events).toEqual([{ type: 'text_delta', delta: 'plain line of output' }]);
  });
});
