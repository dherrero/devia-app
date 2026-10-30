import { describe, it, expect } from 'vitest';
import { buildMemoryProtocolHint, MEMORY_PROTOCOL } from './memory-protocol';

describe('buildMemoryProtocolHint', () => {
  it('returns null when memory is disabled', () => {
    expect(buildMemoryProtocolHint(false)).toBeNull();
  });

  it('returns the protocol when memory is enabled', () => {
    expect(buildMemoryProtocolHint(true)).toBe(MEMORY_PROTOCOL);
  });
});

describe('MEMORY_PROTOCOL content', () => {
  it('documents every devia-memory tool the agent should use', () => {
    for (const tool of [
      'mem_save',
      'mem_search',
      'mem_context',
      'mem_get_observation',
      'mem_save_prompt',
      'mem_session_summary',
    ]) {
      expect(MEMORY_PROTOCOL).toContain(tool);
    }
  });

  it('covers the save / search / close directives', () => {
    expect(MEMORY_PROTOCOL).toContain('SAVE');
    expect(MEMORY_PROTOCOL).toContain('SEARCH');
    expect(MEMORY_PROTOCOL).toContain('CLOSE');
  });

  it('keeps the "Devia persistent memory" anchor the runner test relies on', () => {
    expect(MEMORY_PROTOCOL).toContain('Devia persistent memory');
  });

  it('stays agent-agnostic (no hardcoded vendor name)', () => {
    expect(MEMORY_PROTOCOL).not.toMatch(/\bClaude\b/);
  });

  it('stays compact (S-16 budget guard)', () => {
    // The detailed mem_save field docs live in the tool schema, not here.
    expect(MEMORY_PROTOCOL.length).toBeLessThan(900);
  });
});
