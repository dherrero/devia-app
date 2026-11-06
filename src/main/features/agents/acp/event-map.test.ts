import { describe, expect, it } from 'vitest';
import { createEventMapState, mapPromptUsage, mapSessionUpdate, mapStopReason } from './event-map';

const text = (t: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });

describe('mapSessionUpdate', () => {
  it('emits a text_delta and a one-time streaming status before the first token', () => {
    const state = createEventMapState(1000);
    const first = mapSessionUpdate(text('Hola'), state, 1250);
    const second = mapSessionUpdate(text(' mundo'), state, 1300);
    expect(first).toEqual([
      { type: 'status', label: 'streaming', ttftMs: 250 },
      { type: 'text_delta', delta: 'Hola' },
    ]);
    expect(second).toEqual([{ type: 'text_delta', delta: ' mundo' }]);
  });

  it('dedupes cumulative text chunks', () => {
    const state = createEventMapState(0);
    mapSessionUpdate(text('Hola'), state, 1);
    expect(mapSessionUpdate(text('Hola mundo'), state, 2)).toEqual([{ type: 'text_delta', delta: ' mundo' }]);
  });

  it('keeps identical consecutive chunks that are plain increments', () => {
    const state = createEventMapState(0);
    mapSessionUpdate(text('ha'), state, 1);
    expect(mapSessionUpdate(text('ha'), state, 2)).toEqual([{ type: 'text_delta', delta: 'ha' }]);
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
