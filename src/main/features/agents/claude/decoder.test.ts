import { describe, it, expect } from 'vitest';
import { createClaudeStreamParser } from './decoder';
import type { AgentEvent } from '../../cli-adapters/domain/stream-parser';

function makeParser() {
  const events: AgentEvent[] = [];
  const parser = createClaudeStreamParser((e) => events.push(e));
  return { events, parser };
}

function feed(parser: ReturnType<typeof makeParser>, ...lines: string[]) {
  for (const line of lines) {
    parser.parser.feed(line + '\n');
  }
}

describe('createClaudeStreamParser', () => {
  it('emits text_delta from content_block_delta with text_delta type', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
    );
    const textEvents = p.events.filter((e) => e.type === 'text_delta');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toEqual({ type: 'text_delta', delta: 'Hello' });
  });

  it('emits thinking_delta from content_block_delta with thinking_delta type', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I am thinking...' } }),
    );
    const thinkingDeltas = p.events.filter((e) => e.type === 'thinking_delta');
    expect(thinkingDeltas).toHaveLength(1);
    expect(thinkingDeltas[0]).toEqual({ type: 'thinking_delta', delta: 'I am thinking...' });
  });

  it('emits thinking_start from content_block_start with thinking type', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    );
    expect(p.events.some((e) => e.type === 'thinking_start')).toBe(true);
  });

  it('emits tool_use after content_block_stop with accumulated JSON input', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} } }),
      JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } }),
      JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ls -la"}' } }),
      JSON.stringify({ type: 'content_block_stop', index: 1 }),
    );
    const toolEvents = p.events.filter((e) => e.type === 'tool_use');
    expect(toolEvents).toHaveLength(1);
    const toolEvent = toolEvents[0] as Extract<AgentEvent, { type: 'tool_use' }>;
    expect(toolEvent.name).toBe('Bash');
    expect(toolEvent.id).toBe('tool-1');
    expect(toolEvent.input).toEqual({ command: 'ls -la' });
  });

  it('emits exactly one tool_use event (not one per delta)', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-2', name: 'Read', input: {} } }),
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"/foo"}' } }),
      JSON.stringify({ type: 'content_block_stop', index: 0 }),
    );
    const toolEvents = p.events.filter((e) => e.type === 'tool_use');
    expect(toolEvents).toHaveLength(1);
  });

  it('dedupes tool_use repeated by the assistant wrapper after SDK stream events', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'message_start', message: { id: 'msg-1', model: 'claude-sonnet-4-6' } }),
      JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-ask-1', name: 'AskUserQuestion', input: {} } }),
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"question":"Pick one"}' } }),
      JSON.stringify({ type: 'content_block_stop', index: 0 }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-ask-1', name: 'AskUserQuestion', input: { question: 'Pick one' } },
          ],
        },
      }),
    );
    const toolEvents = p.events.filter((e) => e.type === 'tool_use');
    expect(toolEvents).toHaveLength(1);
    expect((toolEvents[0] as Extract<AgentEvent, { type: 'tool_use' }>).id).toBe('tool-ask-1');
  });

  it('emits usage from message_delta with output tokens', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }),
    );
    const usageEvents = p.events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    const usageEvent = usageEvents[0] as Extract<AgentEvent, { type: 'usage' }>;
    expect(usageEvent.outputTokens).toBe(42);
  });

  it('emits turn_end from message_delta with correct stopReason', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 0 } }),
    );
    const turnEnd = p.events.filter((e) => e.type === 'turn_end');
    expect(turnEnd).toHaveLength(1);
    const te = turnEnd[0] as Extract<AgentEvent, { type: 'turn_end' }>;
    expect(te.stopReason).toBe('max_tokens');
  });

  it('emits status event with model from message_start', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'message_start', message: { id: 'msg-1', model: 'claude-sonnet-4-6', usage: { input_tokens: 10 } } }),
    );
    const statusEvents = p.events.filter((e) => e.type === 'status');
    expect(statusEvents).toHaveLength(1);
    const se = statusEvents[0] as Extract<AgentEvent, { type: 'status' }>;
    expect(se.model).toBe('claude-sonnet-4-6');
    expect(se.label).toBe('streaming');
  });

  // REV-TS-CLI-06-04 — inputTokens from message_start.usage
  it('emits usage event with inputTokens from message_start.usage (REV-TS-CLI-06-04)', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'message_start', message: { id: 'msg-1', model: 'claude-sonnet-4-6', usage: { input_tokens: 512, output_tokens: 0 } } }),
    );
    const usageEvents = p.events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    const ue = usageEvents[0] as Extract<AgentEvent, { type: 'usage' }>;
    expect(ue.inputTokens).toBe(512);
  });

  it('does not emit usage when message_start has no usage field', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'message_start', message: { id: 'msg-1', model: 'claude-opus' } }),
    );
    const usageEvents = p.events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(0);
  });

  it('message_delta usage event includes inputTokens stored from message_start (REV-TS-CLI-06-04)', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'message_start', message: { id: 'msg-1', model: 'claude-sonnet-4-6', usage: { input_tokens: 150 } } }),
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } }),
    );
    const usageEvents = p.events.filter((e) => e.type === 'usage');
    // First usage: from message_start (inputTokens only)
    // Second usage: from message_delta (both inputTokens + outputTokens)
    expect(usageEvents).toHaveLength(2);
    const finalUsage = usageEvents[1] as Extract<AgentEvent, { type: 'usage' }>;
    expect(finalUsage.inputTokens).toBe(150);
    expect(finalUsage.outputTokens).toBe(30);
  });

  it('emits raw event for malformed JSON line', () => {
    const p = makeParser();
    feed(p, 'this is not json{{{');
    const rawEvents = p.events.filter((e) => e.type === 'raw');
    expect(rawEvents).toHaveLength(1);
    const raw = rawEvents[0] as Extract<AgentEvent, { type: 'raw' }>;
    expect(raw.line).toBe('this is not json{{{');
  });

  it('emits raw event for unknown event types', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'some_unknown_event_type', data: 'xyz' }));
    const rawEvents = p.events.filter((e) => e.type === 'raw');
    expect(rawEvents).toHaveLength(1);
  });

  it('does not duplicate text when streaming then assistant wrapper arrives', () => {
    const p = makeParser();
    // First stream text via content_block_delta
    feed(p,
      JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'streamed text' } }),
      // Then Claude Code sends the assistant wrapper with the same content
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'streamed text' }] } }),
    );
    const textEvents = p.events.filter((e) => e.type === 'text_delta');
    expect(textEvents).toHaveLength(1);
    const te = textEvents[0] as Extract<AgentEvent, { type: 'text_delta' }>;
    expect(te.delta).toBe('streamed text');
  });

  it('handles multiple text deltas in sequence', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', world' } }),
    );
    const textEvents = p.events.filter((e) => e.type === 'text_delta');
    expect(textEvents).toHaveLength(2);
    expect((textEvents[0] as Extract<AgentEvent, { type: 'text_delta' }>).delta).toBe('Hello');
    expect((textEvents[1] as Extract<AgentEvent, { type: 'text_delta' }>).delta).toBe(', world');
  });

  it('emits error event for result event with is_error=true', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'result', is_error: true, result: 'Something went wrong' }));
    const errorEvents = p.events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    const err = errorEvents[0] as Extract<AgentEvent, { type: 'error' }>;
    expect(err.message).toBe('Something went wrong');
  });

  it('message_stop does not emit any extra events', () => {
    const p = makeParser();
    const beforeLen = p.events.length;
    feed(p, JSON.stringify({ type: 'message_stop' }));
    expect(p.events.length).toBe(beforeLen);
  });

  it('resets per-turn state on new message_start', () => {
    const p = makeParser();
    // First turn
    feed(p,
      JSON.stringify({ type: 'message_start', message: { id: 'msg-1', model: 'claude-opus' } }),
      JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Turn 1' } }),
    );
    // Second turn — new message_start should reset state
    feed(p,
      JSON.stringify({ type: 'message_start', message: { id: 'msg-2', model: 'claude-haiku' } }),
    );
    const statusEvents = p.events.filter((e) => e.type === 'status');
    expect(statusEvents).toHaveLength(2);
    // Second status should have the new model
    const se2 = statusEvents[1] as Extract<AgentEvent, { type: 'status' }>;
    expect(se2.model).toBe('claude-haiku');
  });

  // REV-TS-CLI-14-02: cover flush() with trailing buffered content
  it('flush() processes buffered trailing content without trailing newline', () => {
    const p = makeParser();
    // Feed without a trailing newline so the line stays in the buffer
    p.parser.feed(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    p.parser.feed('\n');
    p.parser.feed(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'flushed' } }));
    // No newline — content is buffered
    expect(p.events.filter((e) => e.type === 'text_delta')).toHaveLength(0);
    p.parser.flush();
    expect(p.events.filter((e) => e.type === 'text_delta')).toHaveLength(1);
    const te = p.events.find((e) => e.type === 'text_delta') as Extract<AgentEvent, { type: 'text_delta' }>;
    expect(te.delta).toBe('flushed');
  });

  // REV-TS-CLI-14-02: cover assistant wrapper fallback path (no prior streaming)
  it('assistant wrapper emits text and tool_use when no prior streaming occurred', () => {
    const p = makeParser();
    // No content_block_delta was emitted first → streamedAnyText is false
    feed(p, JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Fallback text' },
          { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/a.ts' } },
        ],
      },
    }));
    const textEvents = p.events.filter((e) => e.type === 'text_delta');
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as Extract<AgentEvent, { type: 'text_delta' }>).delta).toBe('Fallback text');
    const toolEvents = p.events.filter((e) => e.type === 'tool_use');
    expect(toolEvents).toHaveLength(1);
    expect((toolEvents[0] as Extract<AgentEvent, { type: 'tool_use' }>).name).toBe('Read');
  });

  // REV-TS-CLI-14-02: cover assistant wrapper with non-array content (early return)
  it('assistant wrapper with missing content array emits nothing', () => {
    const p = makeParser();
    const before = p.events.length;
    feed(p, JSON.stringify({ type: 'assistant', message: {} }));
    expect(p.events.length).toBe(before);
  });

  // Regression: when Claude Code only sends wrapper events (no Anthropic SDK
  // streaming events, i.e. no message_delta), the `result` event must still
  // emit turn_end so the launcher closes stdin and the process exits.
  it('result event emits turn_end even when no message_delta was received', () => {
    const p = makeParser();
    // Simulate a wrapper-only run: assistant wrapper → result
    feed(p,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1' }),
    );
    const turnEndEvents = p.events.filter((e) => e.type === 'turn_end');
    expect(turnEndEvents).toHaveLength(1);
    const te = turnEndEvents[0] as Extract<AgentEvent, { type: 'turn_end' }>;
    expect(te.stopReason).toBe('end_turn');
  });

  it('result event emits turn_end AND session_started when session_id is present', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'abc-123' }));
    expect(p.events.some((e) => e.type === 'turn_end')).toBe(true);
    expect(p.events.some((e) => e.type === 'session_started')).toBe(true);
  });

  it('result event emits turn_end even when SDK message_delta already fired it (idempotent)', () => {
    const p = makeParser();
    // SDK path: message_delta emits turn_end
    feed(p, JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }));
    // Claude Code wrapper: result also emits turn_end
    feed(p, JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
    const turnEndEvents = p.events.filter((e) => e.type === 'turn_end');
    // Two turn_end events — the launcher's closeStdin() is idempotent so this is safe
    expect(turnEndEvents).toHaveLength(2);
  });

  it('emits context_compacted on a compact_boundary system event with metadata', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 123456 },
    }));
    const compacted = p.events.filter((e) => e.type === 'context_compacted');
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toEqual({ type: 'context_compacted', trigger: 'auto', preTokens: 123456 });
  });

  it('emits context_compacted with no metadata when compact_metadata is absent', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'system', subtype: 'compact_boundary' }));
    expect(p.events).toEqual([{ type: 'context_compacted' }]);
  });

  it('emits session_started from system/init (not just from result) — T-194', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }));
    const started = p.events.filter((e) => e.type === 'session_started');
    expect(started).toHaveLength(1);
    expect(started[0]).toEqual({ type: 'session_started', agentSessionId: 's-1' });
    // init is otherwise not renderer-relevant: no context_compacted, no raw.
    expect(p.events.some((e) => e.type === 'context_compacted')).toBe(false);
    expect(p.events.some((e) => e.type === 'raw')).toBe(false);
  });

  it('does not emit session_started on system/init without a session_id', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'system', subtype: 'init' }));
    expect(p.events.some((e) => e.type === 'session_started')).toBe(false);
  });

  it('emits usage with costUsd from result.total_cost_usd', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'result', total_cost_usd: 0.0123, session_id: 'sess-1' }));
    const usageEvents = p.events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    const ue = usageEvents[0] as Extract<AgentEvent, { type: 'usage' }>;
    expect(ue.costUsd).toBe(0.0123);
    expect(p.events.at(-1)?.type).toBe('turn_end');
  });

  it('emits durationMs alongside costUsd from result', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'result', total_cost_usd: 0.05, duration_ms: 1234, session_id: 'sess-1' }));
    const usageEvents = p.events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    const ue = usageEvents[0] as Extract<AgentEvent, { type: 'usage' }>;
    expect(ue.costUsd).toBe(0.05);
    expect(ue.durationMs).toBe(1234);
    expect(p.events.at(-1)?.type).toBe('turn_end');
  });

  it('does NOT emit a result-derived usage when total_cost_usd and duration_ms are absent', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'result', session_id: 'sess-1' }));
    const usageEvents = p.events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(0);
    expect(p.events.at(-1)?.type).toBe('turn_end');
  });

  // ── stream_event wrapper (Claude Code with --include-partial-messages) ────
  // Recent Claude Code releases wrap every Anthropic SDK event inside
  // `{ type: 'stream_event', event: { ...real event... }, session_id, ... }`.
  // Without unwrapping, message_start / content_block_delta / message_delta
  // never reach their handlers and `stream.model` / `usage.inputTokens` /
  // `usage.outputTokens` are silently dropped — which is exactly what was
  // emptying the statusbar's centre block.

  it('unwraps a stream_event-wrapped message_start and emits status with model', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-1', model: 'claude-opus-4-7', usage: { input_tokens: 123 } },
        },
        session_id: 'sess-1',
      }),
    );
    const statusEvents = p.events.filter((e) => e.type === 'status');
    expect(statusEvents).toHaveLength(1);
    const se = statusEvents[0] as Extract<AgentEvent, { type: 'status' }>;
    expect(se.model).toBe('claude-opus-4-7');

    const usageEvents = p.events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect((usageEvents[0] as Extract<AgentEvent, { type: 'usage' }>).inputTokens).toBe(123);
  });

  it('unwraps a stream_event-wrapped content_block_delta into text_delta', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } }),
    );
    const textEvents = p.events.filter((e) => e.type === 'text_delta');
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as Extract<AgentEvent, { type: 'text_delta' }>).delta).toBe('Hello');
  });

  it('extracts model from the assistant wrapper as a fallback for the footer', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'Hi' }],
        },
      }),
    );
    const statusEvents = p.events.filter((e) => e.type === 'status');
    expect(statusEvents).toHaveLength(1);
    expect((statusEvents[0] as Extract<AgentEvent, { type: 'status' }>).model).toBe('claude-sonnet-4-5');
  });

  it('still extracts model from the assistant wrapper even after text was streamed via deltas', () => {
    const p = makeParser();
    feed(p,
      // First stream some text via the SDK deltas so streamedAnyText becomes true.
      JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
      // Then the wrapper arrives — we must still capture `model` (cinturón + tirantes).
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-opus-4-7', content: [{ type: 'text', text: 'Hi' }] },
      }),
    );
    const statusEvents = p.events.filter((e) => e.type === 'status');
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    expect(statusEvents.find((e) => (e as Extract<AgentEvent, { type: 'status' }>).model === 'claude-opus-4-7'))
      .toBeDefined();
    // Text is not duplicated — the wrapper content path is skipped post-stream.
    const textEvents = p.events.filter((e) => e.type === 'text_delta');
    expect(textEvents).toHaveLength(1);
  });

  // ── cached input tokens (cache_creation + cache_read) ───────────────────
  // The Anthropic SDK reports cached prompt tokens in two buckets and
  // counts them OUTSIDE input_tokens. The statusbar's context bar needs
  // the union of all three to reflect what's actually occupying the
  // model's context window — without this the bar was stuck near 0%
  // even on sessions with 400k+ cached tokens.

  it('sums cache_creation and cache_read into cachedInputTokens on message_start', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg-1',
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 12,
            cache_creation_input_tokens: 1841,
            cache_read_input_tokens: 433137,
          },
        },
      }),
    );
    const usageEvents = p.events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    const ue = usageEvents[0] as Extract<AgentEvent, { type: 'usage' }>;
    expect(ue.inputTokens).toBe(12);
    expect(ue.cachedInputTokens).toBe(1841 + 433137);
  });

  it('re-emits cachedInputTokens stored from message_start on the final message_delta usage', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'message_start',
        message: { id: 'msg-1', model: 'claude-opus-4-7', usage: {
          input_tokens: 12, cache_creation_input_tokens: 100, cache_read_input_tokens: 200,
        } },
      }),
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }),
    );
    const usageEvents = p.events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(2);
    const finalUsage = usageEvents[1] as Extract<AgentEvent, { type: 'usage' }>;
    expect(finalUsage.inputTokens).toBe(12);
    expect(finalUsage.cachedInputTokens).toBe(300);
    expect(finalUsage.outputTokens).toBe(50);
  });

  it('prefers cached counts present in message_delta over those stored at message_start', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'message_start',
        message: { id: 'msg-1', model: 'claude-opus-4-7', usage: {
          input_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 200,
        } },
      }),
      JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 50, cache_creation_input_tokens: 1841, cache_read_input_tokens: 433137 },
      }),
    );
    const usageEvents = p.events.filter((e) => e.type === 'usage');
    const finalUsage = usageEvents.at(-1) as Extract<AgentEvent, { type: 'usage' }>;
    expect(finalUsage.cachedInputTokens).toBe(1841 + 433137);
  });

  // result.usage is the SUM of every API request in the run (real capture:
  // last request ~84k, top-level counters ~757k) — using it filled the
  // context bar almost at once. Only the last `iterations` entry counts.
  it('takes context tokens from the last result.usage.iterations entry, not the run-cumulative totals', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'result',
        session_id: 'sess-1',
        total_cost_usd: 0.86,
        duration_ms: 90650,
        usage: {
          input_tokens: 22,
          cache_creation_input_tokens: 75584,
          cache_read_input_tokens: 681318,
          output_tokens: 5976,
          iterations: [
            { input_tokens: 2, cache_creation_input_tokens: 1650, cache_read_input_tokens: 82456, output_tokens: 2380 },
          ],
        },
      }),
    );
    const usageEvents = p.events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    const ue = usageEvents[0] as Extract<AgentEvent, { type: 'usage' }>;
    expect(ue.costUsd).toBe(0.86);
    expect(ue.durationMs).toBe(90650);
    expect(ue.inputTokens).toBe(2);
    expect(ue.cachedInputTokens).toBe(1650 + 82456);
  });

  it('omits context tokens from result when usage has no iterations breakdown', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'result',
        session_id: 'sess-1',
        total_cost_usd: 5.58,
        usage: { input_tokens: 9, cache_creation_input_tokens: 806363, cache_read_input_tokens: 921334 },
      }),
    );
    const ue = p.events.filter((e) => e.type === 'usage')[0] as Extract<AgentEvent, { type: 'usage' }>;
    expect(ue.costUsd).toBe(5.58);
    expect(ue.inputTokens).toBeUndefined();
    expect(ue.cachedInputTokens).toBeUndefined();
  });

  it('a multi-request run ends with the LAST request context, not the cumulative result', () => {
    const p = makeParser();
    const start = (cacheRead: number) => JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: cacheRead } } },
    });
    feed(p,
      start(80_000),
      start(82_000),
      JSON.stringify({
        type: 'result',
        session_id: 'sess-1',
        total_cost_usd: 0.5,
        usage: { input_tokens: 4, cache_read_input_tokens: 162_000 },
      }),
    );
    const merged: { inputTokens?: number; cachedInputTokens?: number } = {};
    for (const e of p.events) {
      if (e.type !== 'usage') continue;
      if (e.inputTokens !== undefined) merged.inputTokens = e.inputTokens;
      if (e.cachedInputTokens !== undefined) merged.cachedInputTokens = e.cachedInputTokens;
    }
    expect((merged.inputTokens ?? 0) + (merged.cachedInputTokens ?? 0)).toBe(82_002);
  });

  it('without partial messages, takes per-request usage from the assistant wrapper', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-opus-5-5', content: [], usage: { input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: 40_000 } },
      }),
    );
    const ue = p.events.find((e) => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>;
    expect(ue.inputTokens).toBe(3);
    expect(ue.cachedInputTokens).toBe(40_500);
  });

  it('with partial messages, does not re-emit usage from the assistant wrapper', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 2 } } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-opus-5-5', content: [], usage: { input_tokens: 2 } },
      }),
    );
    expect(p.events.filter((e) => e.type === 'usage')).toHaveLength(1);
  });

  // ── effective context window from result.modelUsage ─────────────────────
  // Same Anthropic model can ship with multiple windows (Opus 4.7 reports
  // 200k by default but 1M with the extended flag). The CLI reports the
  // active one — forwarding it lets the statusbar's context bar reflect
  // the real ceiling instead of guessing from the model id.

  it('extracts contextWindow from result.modelUsage[<model>].contextWindow', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'result',
        session_id: 'sess-1',
        total_cost_usd: 0.1,
        modelUsage: {
          'claude-opus-4-7': {
            inputTokens: 9,
            outputTokens: 100,
            contextWindow: 1_000_000,
            maxOutputTokens: 64_000,
          },
        },
      }),
    );
    const usageEvents = p.events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    const ue = usageEvents[0] as Extract<AgentEvent, { type: 'usage' }>;
    expect(ue.contextWindow).toBe(1_000_000);
  });

  it('omits contextWindow when modelUsage is absent or has no positive window', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'result', session_id: 'sess-1', total_cost_usd: 0.1 }),
    );
    const usageEvents = p.events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    const ue = usageEvents[0] as Extract<AgentEvent, { type: 'usage' }>;
    expect(ue.contextWindow).toBeUndefined();
  });

  it('picks the window of the run model, not a side model listed first', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5' } },
      }),
      JSON.stringify({
        type: 'result',
        session_id: 'sess-1',
        modelUsage: {
          'claude-haiku-5-5': { contextWindow: 200_000 },
          'claude-opus-5-5': { contextWindow: 1_000_000 },
        },
      }),
    );
    const ue = p.events.filter((e) => e.type === 'usage').at(-1) as Extract<AgentEvent, { type: 'usage' }>;
    expect(ue.contextWindow).toBe(1_000_000);
  });

  it('falls back to the largest window when the run model is unknown', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'result',
        session_id: 'sess-1',
        modelUsage: {
          'claude-haiku-5-5': { contextWindow: 200_000 },
          'claude-opus-5-5': { contextWindow: 1_000_000 },
        },
      }),
    );
    const ue = p.events.find((e) => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>;
    expect(ue.contextWindow).toBe(1_000_000);
  });

  it('emits a usage event for contextWindow alone even when cost/duration/tokens are absent', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'result',
        session_id: 'sess-1',
        modelUsage: { 'claude-opus-4-7': { contextWindow: 200_000 } },
      }),
    );
    const usageEvents = p.events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect((usageEvents[0] as Extract<AgentEvent, { type: 'usage' }>).contextWindow).toBe(200_000);
  });
});
