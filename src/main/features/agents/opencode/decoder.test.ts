import { describe, it, expect } from 'vitest';
import { createOpencodeEventStreamParser } from './decoder';
import type { AgentEvent } from '../../cli-adapters/domain/stream-parser';

function makeParser() {
  const events: AgentEvent[] = [];
  const parser = createOpencodeEventStreamParser((e) => events.push(e));
  return { events, parser };
}

function feed(p: ReturnType<typeof makeParser>, ...lines: string[]) {
  for (const line of lines) {
    p.parser.feed(line + '\n');
  }
}

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

/**
 * Tests cover the OpenCode 1.x `part`-wrapped event format. The legacy
 * flat shape (`{ type: 'tool_use', name, id, input }`) was removed when
 * OpenCode upstream switched envelopes; those tests have been replaced
 * with the new shapes.
 */
describe('createOpencodeEventStreamParser — part-wrapped format', () => {
  it('step_start emits status:running', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'step_start', sessionID: 's1', part: {} }));
    const status = p.events.filter((e) => e.type === 'status') as Extract<AgentEvent, { type: 'status' }>[];
    expect(status).toHaveLength(1);
    expect(expectPresent(status[0]).label).toBe('running');
  });

  it('text event with part.text emits text_delta', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'hello' } }));
    const td = p.events.filter((e) => e.type === 'text_delta') as Extract<AgentEvent, { type: 'text_delta' }>[];
    expect(td).toHaveLength(1);
    expect(expectPresent(td[0]).delta).toBe('hello');
  });

  it('text event with empty part.text is ignored', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'text', sessionID: 's1', part: { text: '' } }));
    expect(p.events.filter((e) => e.type === 'text_delta')).toHaveLength(0);
  });

  it('tool_use with part.tool + callID emits one tool_use', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'tool_use',
      sessionID: 's1',
      part: {
        type: 'tool',
        tool: 'skill',
        callID: 'call_1',
        state: { status: 'running', input: '{"name":"x"}' },
      },
    }));
    const tu = p.events.filter((e) => e.type === 'tool_use') as Extract<AgentEvent, { type: 'tool_use' }>[];
    expect(tu).toHaveLength(1);
    const toolUse = expectPresent(tu[0]);
    expect(toolUse.id).toBe('call_1');
    expect(toolUse.name).toBe('skill');
    expect(toolUse.input).toEqual({ name: 'x' });
  });

  it('repeated tool_use events for the same callID dedupe to one tool_use', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'tool_use',
        sessionID: 's1',
        part: { type: 'tool', tool: 'skill', callID: 'call_1', state: { status: 'pending' } },
      }),
      JSON.stringify({
        type: 'tool_use',
        sessionID: 's1',
        part: { type: 'tool', tool: 'skill', callID: 'call_1', state: { status: 'running' } },
      }),
    );
    expect(p.events.filter((e) => e.type === 'tool_use')).toHaveLength(1);
  });

  it('tool_use with state.status=completed emits tool_use + tool_result', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'tool_use',
      sessionID: 's1',
      part: {
        type: 'tool',
        tool: 'skill',
        callID: 'call_1',
        state: { status: 'completed', output: 'done' },
      },
    }));
    expect(p.events.filter((e) => e.type === 'tool_use')).toHaveLength(1);
    const tr = p.events.filter((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>[];
    expect(tr).toHaveLength(1);
    const toolResult = expectPresent(tr[0]);
    expect(toolResult.toolUseId).toBe('call_1');
    expect(toolResult.content).toBe('done');
  });

  it('step_finish with tokens emits usage including reasoning and cache', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'step_finish',
      sessionID: 's1',
      part: {
        tokens: { input: 100, output: 50, reasoning: 600, cache: { read: 80, write: 20 } },
        cost: 0.001,
      },
    }));
    const u = p.events.filter((e) => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>[];
    expect(u).toHaveLength(1);
    const usage = expectPresent(u[0]);
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.reasoningOutputTokens).toBe(600);
    expect(usage.cachedInputTokens).toBe(80);
    expect(usage.costUsd).toBe(0.001);
  });

  it('step_finish without tokens is ignored', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'step_finish', sessionID: 's1', part: {} }));
    expect(p.events.filter((e) => e.type === 'usage')).toHaveLength(0);
  });

  // T-7: model propagation from step_start
  it('emits status with model when the step_start frame carries a model id', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'step_start', sessionID: 's1', part: {}, model: 'gpt-4o' }));
    const status = p.events.find((e) => e.type === 'status') as Extract<AgentEvent, { type: 'status' }>;
    expect(status).toBeDefined();
    expect(status.model).toBe('gpt-4o');
  });

  it('emits status without model when the step_start frame has no model field', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'step_start', sessionID: 's1', part: {} }));
    const status = p.events.find((e) => e.type === 'status') as Extract<AgentEvent, { type: 'status' }>;
    expect(status?.model).toBeUndefined();
  });

  it('error event emits typed error', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'error', message: 'Provider blew up' }));
    const errs = p.events.filter((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>[];
    expect(errs).toHaveLength(1);
    expect(expectPresent(errs[0]).message).toBe('Provider blew up');
  });

  it('error with nested error.message extracts the inner message', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'error', error: { message: 'Auth failed' } }));
    const errs = p.events.filter((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>[];
    expect(errs).toHaveLength(1);
    expect(expectPresent(errs[0]).message).toBe('Auth failed');
  });

  it('unknown event emits raw', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'completely_unknown_event_xyz' }));
    expect(p.events.filter((e) => e.type === 'raw')).toHaveLength(1);
  });

  it('flush() drains the buffered partial line', () => {
    const p = makeParser();
    p.parser.feed(JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'flushed' } }));
    expect(p.events).toHaveLength(0);
    p.parser.flush();
    expect(p.events.filter((e) => e.type === 'text_delta')).toHaveLength(1);
  });

  it('parallel parser instances do not share tool-use dedupe state', () => {
    const a = makeParser();
    const b = makeParser();
    const payload = JSON.stringify({
      type: 'tool_use',
      sessionID: 's1',
      part: { type: 'tool', tool: 'skill', callID: 'call_1', state: { status: 'running' } },
    });
    feed(a, payload);
    feed(b, payload);
    expect(a.events.filter((e) => e.type === 'tool_use')).toHaveLength(1);
    expect(b.events.filter((e) => e.type === 'tool_use')).toHaveLength(1);
  });

  // UC-FIX-013: sessionID strict guard
  it('AC1: tool_use without sessionID emits raw and does NOT add to dedupe state', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'tool_use',
      // sessionID intentionally omitted
      part: { type: 'tool', tool: 'skill', callID: 'call_x', state: { status: 'running' } },
    }));
    // No tool_use emitted — raw instead
    expect(p.events.filter((e) => e.type === 'tool_use')).toHaveLength(0);
    const raws = p.events.filter((e) => e.type === 'raw') as Extract<AgentEvent, { type: 'raw' }>[];
    expect(raws).toHaveLength(1);
  });

  it('AC1: tool_use with empty sessionID emits raw and does NOT add to dedupe state', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'tool_use',
      sessionID: '',
      part: { type: 'tool', tool: 'skill', callID: 'call_y', state: { status: 'running' } },
    }));
    expect(p.events.filter((e) => e.type === 'tool_use')).toHaveLength(0);
    expect(p.events.filter((e) => e.type === 'raw')).toHaveLength(1);
  });

  it('AC2: two frames with different sessionID but same callID each emit one tool_use', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'tool_use',
        sessionID: 'session-A',
        part: { type: 'tool', tool: 'skill', callID: 'call_1', state: { status: 'running' } },
      }),
      JSON.stringify({
        type: 'tool_use',
        sessionID: 'session-B',
        part: { type: 'tool', tool: 'skill', callID: 'call_1', state: { status: 'running' } },
      }),
    );
    expect(p.events.filter((e) => e.type === 'tool_use')).toHaveLength(2);
  });
});
