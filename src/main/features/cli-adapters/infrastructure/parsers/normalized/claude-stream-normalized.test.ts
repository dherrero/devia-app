import { describe, it, expect } from 'vitest';
import { createClaudeStreamNormalizedParser } from './claude-stream-normalized';
import type { NormalizedEvent } from '../../../../../../shared/domain/normalized-event';

function feed(parser: ReturnType<typeof createClaudeStreamNormalizedParser>, ...lines: string[]): NormalizedEvent[] {
  return lines.flatMap((line) => parser.feed(line + '\n'));
}

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('createClaudeStreamNormalizedParser', () => {
  it('providerId is claude', () => {
    expect(createClaudeStreamNormalizedParser().providerId).toBe('claude');
  });

  it('emits stream_start from message_start with model', () => {
    const p = createClaudeStreamNormalizedParser();
    const events = feed(p, line({ type: 'message_start', message: { model: 'claude-sonnet', usage: {} } }));
    const start = events.find((e) => e.kind === 'stream_start') as Extract<NormalizedEvent, { kind: 'stream_start' }>;
    expect(start).toBeDefined();
    expect(start.model).toBe('claude-sonnet');
    expect(start.protocolVersion).toBe(1);
  });

  it('emits usage with inputTokens from message_start', () => {
    const p = createClaudeStreamNormalizedParser();
    const events = feed(p, line({ type: 'message_start', message: { model: 'm', usage: { input_tokens: 100 } } }));
    const usage = events.find((e) => e.kind === 'usage') as Extract<NormalizedEvent, { kind: 'usage' }>;
    expect(usage?.inputTokens).toBe(100);
  });

  it('emits text_delta from content_block_delta', () => {
    const p = createClaudeStreamNormalizedParser();
    const events = feed(p,
      line({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
    );
    const td = events.filter((e) => e.kind === 'text_delta');
    expect(td).toHaveLength(1);
    expect((td[0] as Extract<NormalizedEvent, { kind: 'text_delta' }>).text).toBe('Hello');
  });

  it('emits thinking_start, thinking_delta, thinking_end', () => {
    const p = createClaudeStreamNormalizedParser();
    const events = feed(p,
      line({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reasoning...' } }),
      line({ type: 'content_block_stop', index: 0 }),
    );
    expect(events.some((e) => e.kind === 'thinking_start')).toBe(true);
    const td = events.find((e) => e.kind === 'thinking_delta') as Extract<NormalizedEvent, { kind: 'thinking_delta' }>;
    expect(td?.text).toBe('Reasoning...');
    expect(events.some((e) => e.kind === 'thinking_end')).toBe(true);
  });

  it('emits tool_call after content_block_stop with accumulated JSON input', () => {
    const p = createClaudeStreamNormalizedParser();
    const events = feed(p,
      line({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} } }),
      line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } }),
      line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ls -la"}' } }),
      line({ type: 'content_block_stop', index: 1 }),
    );
    const tc = events.filter((e) => e.kind === 'tool_call');
    expect(tc).toHaveLength(1);
    const call = tc[0] as Extract<NormalizedEvent, { kind: 'tool_call' }>;
    expect(call.name).toBe('Bash');
    expect(call.toolId).toBe('tool-1');
    expect(call.input).toEqual({ command: 'ls -la' });
  });

  it('emits turn_end from message_delta', () => {
    const p = createClaudeStreamNormalizedParser();
    const events = feed(p,
      line({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }),
    );
    const te = events.find((e) => e.kind === 'turn_end') as Extract<NormalizedEvent, { kind: 'turn_end' }>;
    expect(te?.reason).toBe('end');
  });

  it('maps stop_reason=tool_use to reason=tool_use', () => {
    const p = createClaudeStreamNormalizedParser();
    const events = feed(p, line({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }));
    const te = events.find((e) => e.kind === 'turn_end') as Extract<NormalizedEvent, { kind: 'turn_end' }>;
    expect(te?.reason).toBe('tool_use');
  });

  it('emits stream_end from result event', () => {
    const p = createClaudeStreamNormalizedParser();
    const events = feed(p, line({ type: 'result', is_error: false }));
    expect(events.some((e) => e.kind === 'stream_end')).toBe(true);
  });

  it('emits error from result with is_error: true', () => {
    const p = createClaudeStreamNormalizedParser();
    const events = feed(p, line({ type: 'result', is_error: true, result: 'Something went wrong' }));
    const err = events.find((e) => e.kind === 'error') as Extract<NormalizedEvent, { kind: 'error' }>;
    expect(err).toBeDefined();
    expect(err.message).toBe('Something went wrong');
  });

  // AC2: chunk boundary split
  it('produces same events whether fed in one or two chunks (AC2)', () => {
    const fullLine = line({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n'
      + line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }) + '\n';

    const pA = createClaudeStreamNormalizedParser();
    const evA = pA.feed(fullLine);

    const half = Math.floor(fullLine.length / 2);
    const pB = createClaudeStreamNormalizedParser();
    const evB = [...pB.feed(fullLine.slice(0, half)), ...pB.feed(fullLine.slice(half))];

    expect(evA).toEqual(evB);
  });

  // AC3: malformed JSON
  it('emits PARSER_DESYNC on malformed JSON and stops (AC3)', () => {
    const p = createClaudeStreamNormalizedParser();
    const events = p.feed('not-json\n');
    const err = events.find((e) => e.kind === 'error') as Extract<NormalizedEvent, { kind: 'error' }>;
    expect(err?.code).toBe('PARSER_DESYNC');
    // After desync, further feed returns nothing
    const after = p.feed(line({ type: 'message_start', message: {} }) + '\n');
    expect(after).toHaveLength(0);
  });

  // AC4: overflow
  it('emits PARSER_OVERFLOW when line buffer cap is exceeded (AC4)', () => {
    // We can't easily set the cap via the public API, so test with a huge line
    // that exceeds the default 1 MiB cap
    const p = createClaudeStreamNormalizedParser();
    const hugeLine = 'x'.repeat(1_048_577); // 1 MiB + 1
    const events = p.feed(hugeLine);
    const err = events.find((e) => e.kind === 'error') as Extract<NormalizedEvent, { kind: 'error' }>;
    expect(err?.code).toBe('PARSER_OVERFLOW');
  });

  // AC5: unknown event type is silently ignored
  it('ignores unknown event types without emitting (AC5)', () => {
    const p = createClaudeStreamNormalizedParser();
    const events = p.feed(line({ type: 'some_future_event', data: 123 }) + '\n');
    expect(events).toHaveLength(0);
  });

  // AC6: flush with trailing partial frame
  it('flush drains trailing complete line (AC6)', () => {
    const p = createClaudeStreamNormalizedParser();
    p.feed(line({ type: 'message_start', message: { model: 'x', usage: {} } }) + '\n');
    // Feed a partial line without trailing newline
    p.feed(line({ type: 'result', is_error: false })); // no \n
    const flushed = p.flush();
    expect(flushed.some((e) => e.kind === 'stream_end')).toBe(true);
  });
});
