/**
 * Tests for the Copilot JSONL event stream parser (standalone `copilot
 * --output-format json`): dotted `type`s with payload under `data`.
 */
import { describe, it, expect } from 'vitest';
import { createCopilotEventStreamParser } from './copilot-event-stream';
import type { AgentEvent } from '../../../../../shared/domain/agent-event';

function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}
function feed(lines: string[]): AgentEvent[] {
  const events: AgentEvent[] = [];
  const parser = createCopilotEventStreamParser((e) => events.push(e));
  for (const l of lines) parser.feed(l);
  parser.flush();
  return events;
}

describe('copilot JSONL event stream parser', () => {
  it('emits status with model on session.tools_updated', () => {
    const events = feed([line({ type: 'session.tools_updated', data: { model: 'gpt-5.2' } })]);
    expect(events).toEqual([{ type: 'status', label: 'initializing', model: 'gpt-5.2' }]);
  });

  it('emits streaming status on assistant.turn_start', () => {
    const events = feed([line({ type: 'assistant.turn_start', data: {} })]);
    expect(events).toEqual([{ type: 'status', label: 'streaming' }]);
  });

  it('maps reasoning_delta -> thinking_delta and message_delta -> text_delta', () => {
    const events = feed([
      line({ type: 'assistant.reasoning_delta', data: { deltaContent: 'thinking…' } }),
      line({ type: 'assistant.message_delta', data: { deltaContent: 'Hello' } }),
    ]);
    expect(events).toEqual([
      { type: 'thinking_delta', delta: 'thinking…' },
      { type: 'text_delta', delta: 'Hello' },
    ]);
  });

  it('emits tool_use from tool.execution_start', () => {
    const events = feed([
      line({ type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'Bash', arguments: { command: 'ls' } } }),
    ]);
    expect(events).toEqual([{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }]);
  });

  it('emits tool_result from tool.execution_complete (success:false -> isError)', () => {
    const events = feed([
      line({ type: 'tool.execution_complete', data: { toolCallId: 'c1', result: { content: 'oops' }, success: false } }),
    ]);
    expect(events).toEqual([{ type: 'tool_result', toolUseId: 'c1', content: 'oops', isError: true }]);
  });

  it('emits usage + turn_end on result', () => {
    const events = feed([
      line({ type: 'result', success: true, usage: { input_tokens: 50, output_tokens: 20 } }),
    ]);
    expect(events).toEqual([
      { type: 'usage', inputTokens: 50, outputTokens: 20 },
      { type: 'turn_end', stopReason: 'completed' },
    ]);
  });

  it('marks turn_end as error when result is not successful', () => {
    const events = feed([line({ type: 'result', success: false, exitCode: 1 })]);
    expect(events).toEqual([{ type: 'turn_end', stopReason: 'error' }]);
  });

  it('drops unmapped/ephemeral events silently', () => {
    const events = feed([
      line({ type: 'session.mcp_server_status', data: { server: 'x' } }),
      line({ type: 'assistant.skills_loaded', data: {} }),
    ]);
    expect(events).toEqual([]);
  });

  it('falls back to raw for malformed JSON', () => {
    const events = feed(['not-json\n']);
    expect(events).toEqual([{ type: 'raw', line: 'not-json' }]);
  });
});
