import { describe, it, expect } from 'vitest';
import { foldAssistantText } from './stream-text';

const delta = (text: string): string => JSON.stringify({ type: 'text_delta', delta: text });

describe('foldAssistantText', () => {
  it('accumulates text_delta chunks into the full reply', () => {
    let acc = '';
    acc = foldAssistantText(delta('Hola'), acc);
    acc = foldAssistantText(delta(', '), acc);
    acc = foldAssistantText(delta('mundo'), acc);
    expect(acc).toBe('Hola, mundo');
  });

  it('ignores status / thinking / tool / usage / turn_end lines', () => {
    expect(foldAssistantText(JSON.stringify({ type: 'status', label: 'x' }), 'prev')).toBe('prev');
    expect(foldAssistantText(JSON.stringify({ type: 'thinking_delta', delta: 'hmm' }), 'prev')).toBe('prev');
    expect(foldAssistantText(JSON.stringify({ type: 'tool_use', name: 'Edit' }), 'prev')).toBe('prev');
    expect(foldAssistantText(JSON.stringify({ type: 'tool_result', toolUseId: 't', content: 'x', isError: false }), 'prev')).toBe('prev');
    expect(foldAssistantText(JSON.stringify({ type: 'turn_end', stopReason: 'end_turn' }), 'prev')).toBe('prev');
  });

  it('ignores malformed / non-JSON lines', () => {
    expect(foldAssistantText('not json', 'prev')).toBe('prev');
    expect(foldAssistantText('', 'prev')).toBe('prev');
  });
});
