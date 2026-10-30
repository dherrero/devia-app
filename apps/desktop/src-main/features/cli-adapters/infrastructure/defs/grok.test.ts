import { describe, it, expect } from 'vitest';
import { grokAgentDef } from './grok';

describe('grok def (S-21)', () => {
  it('builds headless JSON argv: -p <prompt> --format json', () => {
    const args = grokAgentDef.buildArgs('do the thing', [], [], {});
    expect(args).toEqual(['-p', 'do the thing', '--format', 'json']);
  });

  it('appends --model when a model is selected', () => {
    const args = grokAgentDef.buildArgs('hi', [], [], { model: 'grok-4.3' });
    expect(args).toEqual(['-p', 'hi', '--format', 'json', '--model', 'grok-4.3']);
  });

  it('never emits --effort (grok-dev has no reasoning-effort flag)', () => {
    const args = grokAgentDef.buildArgs('hi', [], [], { model: 'grok-3-mini', reasoning: 'high' });
    expect(args).not.toContain('--effort');
  });

  it('resumes natively via --session <id>', () => {
    expect(grokAgentDef.buildResumeArgs?.('abc123')).toEqual(['--session', 'abc123']);
  });

  it('is a native json-event-stream agent parsed by grok, prompt via argv', () => {
    expect(grokAgentDef.streamFormat).toBe('json-event-stream');
    expect(grokAgentDef.eventParser).toBe('grok');
    expect(grokAgentDef.continuity ?? 'native').toBe('native');
    expect(grokAgentDef.promptViaStdin).not.toBe(true);
    expect(grokAgentDef.maxPromptArgBytes).toBe(200_000);
    expect(grokAgentDef.systemPromptStrategy).toBe('argv-prepend');
    expect(grokAgentDef.authProbe).toBeTypeOf('function');
  });
});
