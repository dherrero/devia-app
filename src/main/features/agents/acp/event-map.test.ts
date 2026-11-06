import { describe, expect, it } from 'vitest';
import { createEventMapState, mapPromptUsage, mapSessionUpdate, mapStopReason, type EventMapContext } from './event-map';
import { defaultToolName } from './tool-name';
import type { AcpAgentProfile } from './profile';

const text = (t: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });

describe('mapSessionUpdate', () => {
  it('emits a text_delta and a one-time streaming status before the first token', () => {
    const state = createEventMapState(1000);
    const first = mapSessionUpdate(text('Hola'), state, undefined, 1250);
    const second = mapSessionUpdate(text(' mundo'), state, undefined, 1300);
    expect(first).toEqual([
      { type: 'status', label: 'streaming', ttftMs: 250 },
      { type: 'text_delta', delta: 'Hola' },
    ]);
    expect(second).toEqual([{ type: 'text_delta', delta: ' mundo' }]);
  });

  it('dedupes cumulative text chunks', () => {
    const state = createEventMapState(0);
    mapSessionUpdate(text('Hola'), state, undefined, 1);
    expect(mapSessionUpdate(text('Hola mundo'), state, undefined, 2)).toEqual([{ type: 'text_delta', delta: ' mundo' }]);
  });

  it('keeps identical consecutive chunks that are plain increments', () => {
    const state = createEventMapState(0);
    mapSessionUpdate(text('ha'), state, undefined, 1);
    expect(mapSessionUpdate(text('ha'), state, undefined, 2)).toEqual([{ type: 'text_delta', delta: 'ha' }]);
  });

  it('maps thought chunks to thinking_delta', () => {
    const state = createEventMapState(0);
    expect(
      mapSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }, state),
    ).toEqual([{ type: 'thinking_delta', delta: 'hmm' }]);
  });

  it('ignores empty text, non-text content and unknown update kinds', () => {
    const state = createEventMapState(0);
    expect(mapSessionUpdate(text(''), state)).toEqual([]);
    expect(
      mapSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } }, state),
    ).toEqual([]);
    expect(mapSessionUpdate({ sessionUpdate: 'brand_new_kind' }, state)).toEqual([]);
    expect(mapSessionUpdate(null, state)).toEqual([]);
    expect(mapSessionUpdate('nope', state)).toEqual([]);
  });

  it('ignores user_message_chunk, available_commands_update and current_mode_update', () => {
    const state = createEventMapState(0);
    for (const kind of ['user_message_chunk', 'available_commands_update', 'current_mode_update']) {
      expect(mapSessionUpdate({ sessionUpdate: kind, content: { type: 'text', text: 'x' } }, state)).toEqual([]);
    }
  });
});

describe('mapStopReason', () => {
  it('maps stop reasons', () => {
    expect(mapStopReason('end_turn')).toBe('completed');
    expect(mapStopReason('cancelled')).toBe('cancelled');
    expect(mapStopReason('max_tokens')).toBe('max_tokens');
    expect(mapStopReason('max_turn_requests')).toBe('max_turn_requests');
    expect(mapStopReason('refusal')).toBe('refusal');
    expect(mapStopReason('weird')).toBe('completed');
    expect(mapStopReason(undefined)).toBe('completed');
  });
});

describe('mapPromptUsage', () => {
  it('maps prompt usage and returns null without numbers', () => {
    expect(
      mapPromptUsage({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 3, thoughtTokens: 2 } }),
    ).toEqual({ type: 'usage', inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, reasoningOutputTokens: 2 });
    expect(mapPromptUsage({ usage: { inputTokens: 1, outputTokens: 2 } })).toEqual({
      type: 'usage',
      inputTokens: 1,
      outputTokens: 2,
    });
    expect(mapPromptUsage({ stopReason: 'end_turn' })).toBeNull();
    expect(mapPromptUsage({ usage: { inputTokens: 'x' } })).toBeNull();
    expect(mapPromptUsage(null)).toBeNull();
  });
});

const PROFILE: AcpAgentProfile = {
  id: 'fake',
  args: () => [],
  continuity: 'replay',
  planEnforcement: 'none',
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  toolName: defaultToolName,
};
const CTX: EventMapContext = { profile: PROFILE, serverIds: ['devia-kanban'] };

const toolCall = (over: Record<string, unknown> = {}) => ({
  sessionUpdate: 'tool_call',
  toolCallId: 't1',
  title: 'Read file',
  kind: 'read',
  status: 'pending',
  ...over,
});
const toolUpdate = (over: Record<string, unknown> = {}) => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: 't1',
  status: 'completed',
  ...over,
});
const textContent = (t: string) => ({ type: 'content', content: { type: 'text', text: t } });

describe('mapSessionUpdate tools', () => {
  it('tool_call becomes one tool_use with the profile-resolved name', () => {
    const state = createEventMapState(0);
    expect(mapSessionUpdate(toolCall({ rawInput: { path: 'a' } }), state, CTX)).toEqual([
      { type: 'tool_use', id: 't1', name: 'Read file', input: { path: 'a' } },
    ]);
  });

  it('uses the title as input when the agent sends no rawInput', () => {
    const state = createEventMapState(0);
    expect(mapSessionUpdate(toolCall(), state, CTX)).toEqual([
      { type: 'tool_use', id: 't1', name: 'Read file', input: { title: 'Read file' } },
    ]);
  });

  it('an MCP tool comes out as mcp__<server>__<tool>', () => {
    const state = createEventMapState(0);
    const [ev] = mapSessionUpdate(toolCall({ title: 'devia-kanban_kanban_list' }), state, CTX);
    expect(ev).toMatchObject({ type: 'tool_use', name: 'mcp__devia-kanban__kanban_list' });
  });

  it('a repeated tool_call with the same id is not re-emitted', () => {
    const state = createEventMapState(0);
    mapSessionUpdate(toolCall(), state, CTX);
    expect(mapSessionUpdate(toolCall(), state, CTX)).toEqual([]);
  });

  it('completed update becomes a tool_result with the joined text content', () => {
    const state = createEventMapState(0);
    mapSessionUpdate(toolCall(), state, CTX);
    expect(
      mapSessionUpdate(toolUpdate({ content: [textContent('a'), textContent('b')] }), state, CTX),
    ).toEqual([{ type: 'tool_result', toolUseId: 't1', content: 'a\nb', isError: false }]);
  });

  it('falls back to rawOutput and then to an empty string', () => {
    const state = createEventMapState(0);
    mapSessionUpdate(toolCall(), state, CTX);
    mapSessionUpdate(toolCall({ toolCallId: 't2' }), state, CTX);
    expect(mapSessionUpdate(toolUpdate({ rawOutput: { ok: true } }), state, CTX)).toEqual([
      { type: 'tool_result', toolUseId: 't1', content: '{"ok":true}', isError: false },
    ]);
    expect(mapSessionUpdate(toolUpdate({ toolCallId: 't2' }), state, CTX)).toEqual([
      { type: 'tool_result', toolUseId: 't2', content: '', isError: false },
    ]);
  });

  it('failed update marks isError', () => {
    const state = createEventMapState(0);
    mapSessionUpdate(toolCall(), state, CTX);
    expect(mapSessionUpdate(toolUpdate({ status: 'failed' }), state, CTX)).toEqual([
      { type: 'tool_result', toolUseId: 't1', content: '', isError: true },
    ]);
  });

  it('an update for an unseen tool emits tool_use first', () => {
    const state = createEventMapState(0);
    const events = mapSessionUpdate(toolUpdate({ title: 'Grep', content: [textContent('x')] }), state, CTX);
    expect(events.map((e) => e.type)).toEqual(['tool_use', 'tool_result']);
    expect(events[0]).toMatchObject({ id: 't1', name: 'Grep' });
  });

  it('an already finished tool is not finished twice', () => {
    const state = createEventMapState(0);
    mapSessionUpdate(toolCall(), state, CTX);
    mapSessionUpdate(toolUpdate(), state, CTX);
    expect(mapSessionUpdate(toolUpdate(), state, CTX)).toEqual([]);
  });

  it('in-progress updates emit nothing', () => {
    const state = createEventMapState(0);
    mapSessionUpdate(toolCall(), state, CTX);
    expect(mapSessionUpdate(toolUpdate({ status: 'in_progress' }), state, CTX)).toEqual([]);
  });

  it('ignores tools when no context is given', () => {
    const state = createEventMapState(0);
    expect(mapSessionUpdate(toolCall(), state)).toEqual([]);
  });

  it('tool result content is capped at 10000 chars', () => {
    const state = createEventMapState(0);
    mapSessionUpdate(toolCall(), state, CTX);
    const [ev] = mapSessionUpdate(toolUpdate({ content: [textContent('x'.repeat(20_000))] }), state, CTX);
    expect(ev).toMatchObject({ type: 'tool_result' });
    expect((ev as { content: string }).content).toHaveLength(10_000);
  });

  it('plan becomes one status and a repeated identical plan emits nothing', () => {
    const state = createEventMapState(0);
    const plan = { sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'high', status: 'pending' }] };
    expect(mapSessionUpdate(plan, state, CTX)).toEqual([{ type: 'status', label: 'plan: 1 steps' }]);
    expect(mapSessionUpdate(plan, state, CTX)).toEqual([]);
    const changed = { sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'high', status: 'completed' }] };
    expect(mapSessionUpdate(changed, state, CTX)).toEqual([{ type: 'status', label: 'plan: 1 steps' }]);
  });
});
