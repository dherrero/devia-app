import { describe, it, expect } from 'vitest';
import { buildMemoryContextHint } from './memory-context-hint';
import { memoryHintBudgetChars } from '../../../../shared/domain/context-budget';
import type { MemoryRecall } from '../../../../shared/domain/memory';

describe('memoryHintBudgetChars (E-DSK-13 #319)', () => {
  it('caps a large window to the ceiling', () => {
    expect(memoryHintBudgetChars('claude', 'claude-opus-4-7')).toBe(6000); // 200k → 1500 tok
  });

  it('scales down for the minimum/unknown window', () => {
    // Unknown CLI → MINIMUM_CONTEXT_LENGTH (64k) → 960 tok → 3840 chars.
    expect(memoryHintBudgetChars('totally-unknown-cli')).toBe(3840);
  });

  it('always stays within sane bounds', () => {
    for (const [cli, model] of [['claude', 'claude-opus-4-7'], ['gemini', 'gemini-2.5-pro'], ['x', undefined]] as const) {
      const b = memoryHintBudgetChars(cli, model);
      expect(b).toBeGreaterThanOrEqual(1200);
      expect(b).toBeLessThanOrEqual(6000);
    }
  });
});

const empty: MemoryRecall = { observations: [], summaries: [] };

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

describe('buildMemoryContextHint', () => {
  it('returns null when there is nothing to inject', () => {
    expect(buildMemoryContextHint(empty)).toBeNull();
    expect(buildMemoryContextHint({ observations: [], summaries: ['', '  '] })).toBeNull();
  });

  it('renders relevant observations tagged by type, in the given order', () => {
    const out = buildMemoryContextHint({
      observations: [
        { type: 'decision', title: 'Chose Signals over RxJS', content: 'less boilerplate' },
        { type: 'bugfix', title: 'Fixed N+1 in user list', content: 'eager load' },
      ],
      summaries: [],
    });
    const text = expectPresent(out);
    expect(text).toContain('## Memory from previous sessions');
    expect(text).toContain('Relevant to this task:');
    expect(text).toContain('- [decision] Chose Signals over RxJS — less boilerplate');
    expect(text).toContain('- [bugfix] Fixed N+1 in user list — eager load');
    expect(text.indexOf('[decision]')).toBeLessThan(text.indexOf('[bugfix]'));
  });

  it('renders recent session summaries under their own heading', () => {
    const out = buildMemoryContextHint({ observations: [], summaries: ['Implemented login flow'] });
    expect(out).toContain('Recent sessions:');
    expect(out).toContain('- Implemented login flow');
    expect(out).not.toContain('Relevant to this task:');
  });

  it('shows both sections when both are present, observations first', () => {
    const out = buildMemoryContextHint({
      observations: [{ type: 'pattern', title: 'Repo layout', content: 'feature folders' }],
      summaries: ['Session A'],
    });
    const text = expectPresent(out);
    expect(text.indexOf('Relevant to this task:')).toBeLessThan(text.indexOf('Recent sessions:'));
  });

  it('drops the title/content separator when content duplicates the title', () => {
    const out = buildMemoryContextHint({
      observations: [{ type: 'config', title: 'same', content: 'same' }],
      summaries: [],
    });
    expect(out).toContain('- [config] same');
    expect(out).not.toContain('same — same');
  });

  it('collapses whitespace in both sections', () => {
    const out = buildMemoryContextHint({
      observations: [{ type: 'discovery', title: 'A\n\n B', content: 'c   d' }],
      summaries: ['x\n\ny'],
    });
    expect(out).toContain('- [discovery] A B — c d');
    expect(out).toContain('- x y');
  });

  it('respects the char budget and reports how many were omitted', () => {
    const observations = Array.from({ length: 30 }, (_, i) => ({
      type: 'learning' as const,
      title: `Observation number ${i}`,
      content: 'some content here',
    }));
    const out = buildMemoryContextHint({ observations, summaries: [] }, { maxChars: 320 });
    expect(out).toMatch(/…\(\d+ more in memory\)/);
    expect(out).toContain('[learning] Observation number 0');
  });

  it('wraps the recalled content in an untrusted-data fence with non-imperative framing', () => {
    const out = buildMemoryContextHint({
      observations: [{ type: 'decision', title: 'X', content: 'y' }],
      summaries: [],
    });
    expect(out).toContain('<devia-memory trust="low" role="reference">');
    expect(out).toContain('</devia-memory>');
    expect(out).toContain('NOT instructions');
  });

  it('redacts secrets before they re-enter the prompt (E-DSK-13 #315)', () => {
    const out = buildMemoryContextHint({
      observations: [{ type: 'config', title: 'API key', content: 'sk-ABCDEFGHIJKLMNOP1234567890' }],
      summaries: ['token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'],
    });
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-ABCDEFGHIJKLMNOP1234567890');
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
  });

  it('always keeps at least one line even under a tiny budget', () => {
    const out = buildMemoryContextHint(
      { observations: [{ type: 'decision', title: 'only one', content: '' }], summaries: [] },
      { maxChars: 1 },
    );
    expect(out).toContain('- [decision] only one');
  });
});
