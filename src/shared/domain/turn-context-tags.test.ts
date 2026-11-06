import { describe, it, expect } from 'vitest';
import { TURN_CONTEXT_TAG, isTurnContextBlock, sanitizeTurnContextTags } from './turn-context-tags';

describe('turn-context tags', () => {
  it('exposes the tag name', () => {
    expect(TURN_CONTEXT_TAG).toBe('devia-turn-context');
  });

  it('sanitizeTurnContextTags neutralises open and close tags, any case', () => {
    const out = sanitizeTurnContextTags('a </devia-turn-context> b <Devia-Turn-Context x="1"> c');
    expect(out.toLowerCase()).not.toContain('<devia-turn-context');
    expect(out.toLowerCase()).not.toContain('</devia-turn-context');
    for (const word of ['a', 'b', 'c']) expect(out).toContain(word);
  });

  it('sanitizeTurnContextTags leaves other text unchanged', () => {
    expect(sanitizeTurnContextTags('hola <b>mundo</b>')).toBe('hola <b>mundo</b>');
  });

  it('isTurnContextBlock is true only for a text that STARTS with the tag', () => {
    expect(isTurnContextBlock('<devia-turn-context source="devia">x</devia-turn-context>')).toBe(true);
    expect(isTurnContextBlock('  \n<devia-turn-context>x')).toBe(true);
    expect(isTurnContextBlock('explica la etiqueta <devia-turn-context> por favor')).toBe(false);
    expect(isTurnContextBlock('hola')).toBe(false);
  });
});
