import { describe, it, expect } from 'vitest';
import type { DiffResult } from './git';
import {
  buildReviewPrompt,
  diffSignature,
  reconcileComments,
  type ReviewComment,
  type ReviewPromptLabels,
} from './review-comment';

const LABELS: ReviewPromptLabels = {
  prefix: 'revisa:',
  fileLabel: 'archivo:',
  linePrefix: 'L-',
  commentLabel: 'comentario:',
};

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    filePath: '/ws/proj/src/a.ts',
    line: 57,
    side: 'new',
    lineText: 'const x = 1;',
    text: 'esta variable no es suficientemente específica',
    ...over,
  };
}

function diff(files: DiffResult['files']): DiffResult {
  return { hasChanges: files.length > 0, files };
}

describe('buildReviewPrompt', () => {
  it('returns empty string with no comments', () => {
    expect(buildReviewPrompt([], LABELS)).toBe('');
  });

  it('renders the expected single-comment shape', () => {
    const out = buildReviewPrompt([comment()], LABELS, (p) => p.replace('/ws/proj/', '/'));
    expect(out).toBe(
      'revisa:\n'
      + 'archivo: /src/a.ts L-57\n'
      + 'comentario: esta variable no es suficientemente específica',
    );
  });

  it('separates multiple comments with a blank line', () => {
    const out = buildReviewPrompt(
      [comment({ line: 10, text: 'uno' }), comment({ line: 20, text: 'dos' })],
      LABELS,
    );
    const blocks = out.split('\n\n');
    expect(blocks).toHaveLength(2);
    expect(out.startsWith('revisa:\n')).toBe(true);
  });

  it('sorts by display path then line', () => {
    const out = buildReviewPrompt(
      [
        comment({ filePath: '/ws/proj/b.ts', line: 5, text: 'b5' }),
        comment({ filePath: '/ws/proj/a.ts', line: 30, text: 'a30' }),
        comment({ filePath: '/ws/proj/a.ts', line: 9, text: 'a9' }),
      ],
      LABELS,
    );
    expect(out.indexOf('a9')).toBeLessThan(out.indexOf('a30'));
    expect(out.indexOf('a30')).toBeLessThan(out.indexOf('b5'));
  });

  it('trims comment text', () => {
    const out = buildReviewPrompt([comment({ text: '  hola  ' })], LABELS);
    expect(out.endsWith('comentario: hola')).toBe(true);
  });
});

describe('diffSignature', () => {
  const sample = diff([
    { path: '/ws/a.ts', status: 'modified', lines: [
      { type: 'context', oldLineNo: 1, newLineNo: 1, text: 'a' },
      { type: 'add', newLineNo: 2, text: 'b' },
    ] },
  ]);

  it('is idempotent for identical input', () => {
    expect(diffSignature(sample)).toBe(diffSignature(sample));
  });

  it('returns "empty" when there are no changes', () => {
    expect(diffSignature(diff([]))).toBe('empty');
  });

  it('changes when line content changes', () => {
    const mutated = diff([
      { path: '/ws/a.ts', status: 'modified', lines: [
        { type: 'context', oldLineNo: 1, newLineNo: 1, text: 'a' },
        { type: 'add', newLineNo: 2, text: 'B-CHANGED' },
      ] },
    ]);
    expect(diffSignature(mutated)).not.toBe(diffSignature(sample));
  });
});

describe('reconcileComments', () => {
  const current = diff([
    { path: '/ws/proj/src/a.ts', status: 'modified', lines: [
      { type: 'context', oldLineNo: 56, newLineNo: 56, text: 'prev' },
      { type: 'add', newLineNo: 57, text: 'const x = 1;' },
    ] },
  ]);

  it('keeps a comment whose anchored line still matches', () => {
    const { kept, dropped } = reconcileComments([comment()], current);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('drops every comment when the diff is empty (commit/stash)', () => {
    const { kept, dropped } = reconcileComments([comment()], diff([]));
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it('drops a comment when the line text changed (line drift)', () => {
    const { dropped } = reconcileComments([comment({ lineText: 'const x = 2;' })], current);
    expect(dropped).toHaveLength(1);
  });

  it('drops a comment when its file is no longer in the diff', () => {
    const { dropped } = reconcileComments([comment({ filePath: '/ws/proj/gone.ts' })], current);
    expect(dropped).toHaveLength(1);
  });

  it('respects the side: a new-side line does not satisfy an old-side anchor', () => {
    const { dropped } = reconcileComments([comment({ side: 'old' })], current);
    expect(dropped).toHaveLength(1);
  });

  it('never matches hunk lines', () => {
    const withHunk = diff([
      { path: '/ws/proj/src/a.ts', status: 'modified', lines: [
        { type: 'hunk', text: '@@ -57,1 +57,1 @@' },
      ] },
    ]);
    const { dropped } = reconcileComments([comment({ lineText: '@@ -57,1 +57,1 @@' })], withHunk);
    expect(dropped).toHaveLength(1);
  });
});
