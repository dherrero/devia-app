/**
 * Tests for the DeepSeek (DeepSeek-TUI / CodeWhale) adapter — `exec --auto`
 * with the prompt as the trailing positional argv.
 */
import { describe, it, expect } from 'vitest';
import { deepseekAgentDef } from './deepseek';

describe('deepseek def', () => {
  it('runs `exec --auto` with the prompt as the trailing positional', () => {
    const args = deepseekAgentDef.buildArgs('fix the bug', [], [], {});
    expect(args).toEqual(['exec', '--auto', 'fix the bug']);
    expect(deepseekAgentDef.promptViaStdin).not.toBe(true);
  });

  it('inserts --model before the positional prompt when set', () => {
    const args = deepseekAgentDef.buildArgs('hi', [], [], { model: 'deepseek-v4-pro' });
    expect(args).toEqual(['exec', '--auto', '--model', 'deepseek-v4-pro', 'hi']);
  });

  it('targets the deepseek/codewhale dispatcher and guards the argv budget', () => {
    expect(deepseekAgentDef.bin).toBe('deepseek');
    expect(deepseekAgentDef.fallbackBins).toEqual(['codewhale']);
    expect(deepseekAgentDef.name).toBe('DeepSeek TUI');
    expect(deepseekAgentDef.maxPromptArgBytes).toBe(30_000);
    expect(deepseekAgentDef.systemPromptStrategy).toBe('unsupported');
  });
});
