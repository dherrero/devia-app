import { describe, it, expect } from 'vitest';
import { createJsonEventStreamNormalizedParser } from './json-event-stream-normalized';
import type { NormalizedEvent } from '../../../../../../shared/domain/normalized-event';

function feed(parser: ReturnType<typeof createJsonEventStreamNormalizedParser>, ...lines: string[]): NormalizedEvent[] {
  return lines.flatMap((line) => parser.feed(line + '\n'));
}

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('createJsonEventStreamNormalizedParser', () => {
  it('providerId matches constructor argument', () => {
    expect(createJsonEventStreamNormalizedParser('codex').providerId).toBe('codex');
  });

  it('emits stream_start on first event', () => {
    const p = createJsonEventStreamNormalizedParser('codex');
    const events = feed(p, line({ type: 'thread.started', thread_id: 'abc' }));
    expect(events.some((e) => e.kind === 'stream_start')).toBe(true);
  });

  it('emits status:initializing from thread.started', () => {
    const p = createJsonEventStreamNormalizedParser('codex');
    const events = feed(p, line({ type: 'thread.started' }));
    const st = events.find((e) => e.kind === 'status') as Extract<NormalizedEvent, { kind: 'status' }>;
    expect(st?.label).toBe('initializing');
  });

  it('emits status:running from turn.started', () => {
    const p = createJsonEventStreamNormalizedParser('codex');
    const events = feed(p, line({ type: 'turn.started' }));
    const st = events.find((e) => e.kind === 'status') as Extract<NormalizedEvent, { kind: 'status' }>;
    expect(st?.label).toBe('running');
  });

  it('emits tool_call from item.started command_execution', () => {
    const p = createJsonEventStreamNormalizedParser('codex');
    const events = feed(p, line({ type: 'item.started', item: { id: 'exec-1', type: 'command_execution', command: 'ls' } }));
    const tc = events.find((e) => e.kind === 'tool_call') as Extract<NormalizedEvent, { kind: 'tool_call' }>;
    expect(tc?.toolId).toBe('exec-1');
    expect(tc?.name).toBe('Bash');
    expect((tc?.input as { command: string }).command).toBe('ls');
  });

  it('emits tool_result from item.completed command_execution', () => {
    const p = createJsonEventStreamNormalizedParser('codex');
    feed(p, line({ type: 'item.started', item: { id: 'exec-1', type: 'command_execution', command: 'ls' } }));
    const events = feed(p, line({ type: 'item.completed', item: { id: 'exec-1', type: 'command_execution', aggregated_output: 'file1\n', exit_code: 0 } }));
    const tr = events.find((e) => e.kind === 'tool_result') as Extract<NormalizedEvent, { kind: 'tool_result' }>;
    expect(tr?.toolId).toBe('exec-1');
    expect(tr?.isError).toBe(false);
    expect(tr?.content).toBe('file1\n');
  });

  it('emits text_delta from item.completed agent_message', () => {
    const p = createJsonEventStreamNormalizedParser('codex');
    const events = feed(p, line({ type: 'item.completed', item: { type: 'agent_message', text: 'Hello!' } }));
    const td = events.find((e) => e.kind === 'text_delta') as Extract<NormalizedEvent, { kind: 'text_delta' }>;
    expect(td?.text).toBe('Hello!');
  });

  it('emits usage and turn_end from turn.completed', () => {
    const p = createJsonEventStreamNormalizedParser('codex');
    const events = feed(p, line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } }));
    const usage = events.find((e) => e.kind === 'usage') as Extract<NormalizedEvent, { kind: 'usage' }>;
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBe(20);
    expect(events.some((e) => e.kind === 'turn_end')).toBe(true);
  });

  it('emits error from error event', () => {
    const p = createJsonEventStreamNormalizedParser('codex');
    const events = feed(p, line({ type: 'error', message: 'Something failed' }));
    const err = events.find((e) => e.kind === 'error') as Extract<NormalizedEvent, { kind: 'error' }>;
    expect(err?.message).toBe('Something failed');
  });

  it('emits error from turn.failed', () => {
    const p = createJsonEventStreamNormalizedParser('codex');
    const events = feed(p, line({ type: 'turn.failed', error: { message: 'Auth failed' } }));
    const err = events.find((e) => e.kind === 'error') as Extract<NormalizedEvent, { kind: 'error' }>;
    expect(err?.message).toBe('Auth failed');
  });

  // AC2: chunk boundary split
  it('produces same events regardless of chunk splits (AC2)', () => {
    const fullInput = line({ type: 'thread.started' }) + '\n'
      + line({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }) + '\n';

    const pA = createJsonEventStreamNormalizedParser('codex');
    const evA = pA.feed(fullInput);

    const half = Math.floor(fullInput.length / 2);
    const pB = createJsonEventStreamNormalizedParser('codex');
    const evB = [...pB.feed(fullInput.slice(0, half)), ...pB.feed(fullInput.slice(half))];

    expect(evA).toEqual(evB);
  });

  // AC3: malformed JSON
  it('emits PARSER_DESYNC on malformed JSON (AC3)', () => {
    const p = createJsonEventStreamNormalizedParser('codex');
    const events = p.feed('not-json\n');
    const err = events.find((e) => e.kind === 'error') as Extract<NormalizedEvent, { kind: 'error' }>;
    expect(err?.code).toBe('PARSER_DESYNC');
  });

  // AC5: unknown event types ignored
  it('ignores unknown event types (AC5)', () => {
    const p = createJsonEventStreamNormalizedParser('codex');
    const events = feed(p, line({ type: 'some.future.event', data: {} }));
    // Only stream_start is emitted (first event); no error
    expect(events.every((e) => e.kind !== 'error')).toBe(true);
  });

  it('flush emits stream_end', () => {
    const p = createJsonEventStreamNormalizedParser('codex');
    const flushed = p.flush();
    expect(flushed.some((e) => e.kind === 'stream_end')).toBe(true);
  });
});
