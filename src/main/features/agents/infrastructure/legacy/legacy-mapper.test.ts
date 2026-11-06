import { describe, it, expect } from 'vitest';
import { geminiAgentDef } from '../../../cli-adapters/infrastructure/defs/gemini';
import { LegacyMapper } from './legacy-mapper';

describe('LegacyMapper', () => {
  it('does not declare a frozen system prompt (it re-sends the full prompt every run)', () => {
    const mapper = new LegacyMapper(geminiAgentDef, { nativeMcp: { deliver: () => ({ file: null, deliveredServerIds: [] }) } });
    expect(mapper.freezesSystemPrompt).toBe(false);
  });
});
