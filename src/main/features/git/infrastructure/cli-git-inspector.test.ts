import { describe, it, expect } from 'vitest';
import { parsePorcelainV2 } from './cli-git-inspector';

describe('parsePorcelainV2 (HT-ST-02)', () => {
  it('returns zero ahead/behind/changedCount and empty branch on an empty input', () => {
    expect(parsePorcelainV2('')).toEqual({
      branch: '',
      ahead: 0,
      behind: 0,
      changedCount: 0,
    });
  });

  it('extracts the current branch from `# branch.head`', () => {
    const raw = [
      '# branch.oid 1234abcd',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
      '',
    ].join('\n');
    expect(parsePorcelainV2(raw).branch).toBe('main');
  });

  it('falls back to ahead=behind=0 when branch.ab is absent (no upstream)', () => {
    const raw = ['# branch.head feature/x', ''].join('\n');
    const summary = parsePorcelainV2(raw);
    expect(summary.ahead).toBe(0);
    expect(summary.behind).toBe(0);
  });

  it('parses ahead and behind from `# branch.ab +N -M`', () => {
    const raw = [
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +3 -7',
      '',
    ].join('\n');
    const summary = parsePorcelainV2(raw);
    expect(summary.ahead).toBe(3);
    expect(summary.behind).toBe(7);
  });

  it('counts modified entries (lines starting with `1` or `2`)', () => {
    const raw = [
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
      '1 .M N... 100644 100644 100644 aaaa bbbb path/to/file.ts',
      '1 M. N... 100644 100644 100644 cccc dddd another/file.scss',
      '2 R. N... 100644 100644 100644 eeee ffff R100 new old',
      '',
    ].join('\n');
    expect(parsePorcelainV2(raw).changedCount).toBe(3);
  });

  it('counts untracked entries (`?`) but ignores ignored entries (`!`)', () => {
    const raw = [
      '# branch.head main',
      '? new-file.ts',
      '? another.png',
      '! ignored-by-gitignore.log',
      '! another-ignored.tmp',
      '',
    ].join('\n');
    expect(parsePorcelainV2(raw).changedCount).toBe(2);
  });

  it('handles a complex mixed status', () => {
    const raw = [
      '# branch.oid abc123',
      '# branch.head feat/desktop-new-styles',
      '# branch.upstream origin/feat/desktop-new-styles',
      '# branch.ab +5 -2',
      '1 .M N... 100644 100644 100644 a b src/a.ts',
      '1 M. N... 100644 100644 100644 c d src/b.scss',
      '? docs/notes.md',
      '! .DS_Store',
      'u UU N... 100644 100644 100644 100644 e f g src/conflict.ts',
      '',
    ].join('\n');
    const summary = parsePorcelainV2(raw);
    expect(summary).toEqual({
      branch: 'feat/desktop-new-styles',
      ahead: 5,
      behind: 2,
      changedCount: 4, // two `1`, one `?`, one `u` (! ignored)
    });
  });
});
