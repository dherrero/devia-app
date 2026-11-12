import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverFiles } from './discover';
import { createIgnore } from './ignore';

const isSupported = (rel: string): boolean => /\.(ts|py|go)$/.test(rel);

let root: string;

function write(rel: string, content = 'x'): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-discover-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function rels(r: { files: { relPath: string }[] }): string[] {
  return r.files.map((f) => f.relPath);
}

describe('discoverFiles', () => {
  it('discovers supported files and skips default ignores', async () => {
    write('src/a.ts');
    write('src/readme.md');
    write('node_modules/x.ts');
    const r = await discoverFiles(root, { isSupported });
    expect(rels(r)).toEqual(['src/a.ts']);
    expect(r.skipped).toContainEqual({
      path: 'node_modules',
      reason: 'ignored',
    });
    const f = r.files[0];
    expect(f?.absPath).toBe(path.join(root, 'src', 'a.ts'));
    expect(f?.size).toBe(1);
    expect(f?.mtimeMs).toBeGreaterThan(0);
  });

  it('respects root and nested .gitignore', async () => {
    write('.gitignore', 'gen/\n');
    write('gen/a.ts');
    write('src/b.ts');
    write('src/.gitignore', '*.ts\n!keep.ts\n');
    write('src/keep.ts');
    write('src/drop.ts');
    const r = await discoverFiles(root, { isSupported });
    expect(rels(r)).toEqual(['src/keep.ts']);
  });

  it('does not follow symlink cycles and reports symlink', async () => {
    write('src/a.ts');
    fs.symlinkSync(root, path.join(root, 'src', 'loop'), 'dir');
    fs.symlinkSync(
      path.join(root, 'src', 'a.ts'),
      path.join(root, 'src', 'link.ts'),
    );
    const r = await discoverFiles(root, { isSupported });
    expect(rels(r)).toEqual(['src/a.ts']);
    expect(r.skipped).toContainEqual({ path: 'src/loop', reason: 'symlink' });
    expect(r.skipped).toContainEqual({
      path: 'src/link.ts',
      reason: 'symlink',
    });
  });

  it('reports too-large files', async () => {
    write('big.ts', 'a\n'.repeat(1_000_000));
    write('ok.ts');
    const r = await discoverFiles(root, { isSupported });
    expect(rels(r)).toEqual(['ok.ts']);
    expect(r.skipped).toContainEqual({ path: 'big.ts', reason: 'too-large' });
  });

  it('honours maxFileBytes', async () => {
    write('a.ts', 'abcdef');
    const r = await discoverFiles(root, { isSupported, maxFileBytes: 3 });
    expect(rels(r)).toEqual([]);
  });

  it('reports minified files by long line and by average line length', async () => {
    write('min.ts', 'a'.repeat(20_000));
    write('avg.ts', `${'b'.repeat(400)}\n`.repeat(200));
    write('normal.ts', 'const a = 1;\n'.repeat(5000));
    const r = await discoverFiles(root, { isSupported });
    expect(rels(r)).toEqual(['normal.ts']);
    expect(r.skipped).toContainEqual({ path: 'min.ts', reason: 'minified' });
    expect(r.skipped).toContainEqual({ path: 'avg.ts', reason: 'minified' });
  });

  it('round-trips spaces, unicode and emoji with forward slashes', async () => {
    write('mi carpeta/ñandú.py');
    write('😀 dir/ファイル.go');
    const r = await discoverFiles(root, { isSupported });
    expect(rels(r).sort()).toEqual(
      ['mi carpeta/ñandú.py', '😀 dir/ファイル.go'].sort(),
    );
  });

  it('returns files sorted by relPath', async () => {
    write('z.ts');
    write('b/a.ts');
    write('a.ts');
    const r = await discoverFiles(root, { isSupported });
    expect(rels(r)).toEqual(['a.ts', 'b/a.ts', 'z.ts']);
  });

  it('reports unreadable directories without throwing', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    write('locked/a.ts');
    write('ok.ts');
    fs.chmodSync(path.join(root, 'locked'), 0o000);
    try {
      const r = await discoverFiles(root, { isSupported });
      expect(rels(r)).toEqual(['ok.ts']);
      expect(r.skipped).toContainEqual({
        path: 'locked',
        reason: 'unreadable',
      });
    } finally {
      fs.chmodSync(path.join(root, 'locked'), 0o755);
    }
  });

  it('throws AbortError when the signal is aborted', async () => {
    write('a.ts');
    const ac = new AbortController();
    ac.abort();
    await expect(
      discoverFiles(root, { isSupported, signal: ac.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('works on a folder that is not a git repository', async () => {
    write('a.go');
    const r = await discoverFiles(root, { isSupported });
    expect(rels(r)).toEqual(['a.go']);
  });
});

describe('createIgnore', () => {
  it('applies default ignores at any depth', () => {
    write('x', '');
    const ig = createIgnore(root);
    expect(ig('node_modules', true)).toBe(true);
    expect(ig('pkg/node_modules/a.ts', false)).toBe(true);
    expect(ig('src/a.ts', false)).toBe(false);
    for (const d of [
      'dist',
      'build',
      'out',
      '.dart_tool',
      '.idea',
      '.vscode',
      '__pycache__',
      '.venv',
      'venv',
      'vendor',
      'target',
      'coverage',
      '.next',
      '.angular',
    ]) {
      expect(ig(d, true)).toBe(true);
    }
  });

  it('always ignores .git even when negated', () => {
    write('.gitignore', '!.git\n!.git/**\n');
    const ig = createIgnore(root);
    expect(ig('.git', true)).toBe(true);
    expect(ig('.git/config', false)).toBe(true);
  });

  it('supports negation, globstar, dir-only, anchoring, comments and escapes', () => {
    write(
      '.gitignore',
      [
        '# comment',
        '',
        '*.log',
        '!important.log',
        '/rootonly.ts',
        'docs/**/*.tmp',
        'cache/',
        '\\#hash.ts',
        '\\!bang.ts',
        'a/b.ts',
      ].join('\n'),
    );
    const ig = createIgnore(root);
    expect(ig('x/y.log', false)).toBe(true);
    expect(ig('x/important.log', false)).toBe(false);
    expect(ig('rootonly.ts', false)).toBe(true);
    expect(ig('sub/rootonly.ts', false)).toBe(false);
    expect(ig('docs/a/b/c.tmp', false)).toBe(true);
    expect(ig('docs/c.tmp', false)).toBe(true);
    expect(ig('docs/c.txt', false)).toBe(false);
    expect(ig('cache', true)).toBe(true);
    expect(ig('cache', false)).toBe(false);
    expect(ig('src/cache/a.ts', false)).toBe(true);
    expect(ig('#hash.ts', false)).toBe(true);
    expect(ig('!bang.ts', false)).toBe(true);
    expect(ig('a/b.ts', false)).toBe(true);
    expect(ig('z/a/b.ts', false)).toBe(false);
  });

  it('normalises windows backslashes', () => {
    write('.gitignore', 'gen/\n');
    const ig = createIgnore(root);
    expect(ig('src\\gen\\a.ts', false)).toBe(true);
    expect(ig('src\\node_modules', true)).toBe(true);
  });

  it('matches many-wildcard and class patterns without backtracking on a hostile .gitignore', () => {
    write(
      '.gitignore',
      [`${'*a'.repeat(14)}b`, 'gen/**/x*/*/*.snap', 'lib/[a-c]?[!z].ts', 'bad[z-a].ts'].join('\n'),
    );
    const ig = createIgnore(root);
    const start = performance.now();
    // ~O(n^14) for a backtracking RegExp: it would not return in the lifetime of the test run.
    expect(ig(`${'a'.repeat(60)}.ts`, false)).toBe(false);
    expect(ig(`src/${'a'.repeat(30)}b`, false)).toBe(true);
    expect(performance.now() - start).toBeLessThan(5000);
    expect(ig('gen/p/q/xy/z/a.snap', false)).toBe(true);
    expect(ig('gen/xy/z/a.snap', false)).toBe(true);
    expect(ig('gen/xy/a.snap', false)).toBe(false);
    expect(ig('lib/b1y.ts', false)).toBe(true);
    expect(ig('lib/b1z.ts', false)).toBe(false);
    expect(ig('lib/d1y.ts', false)).toBe(false);
    expect(ig('badz.ts', false)).toBe(false);
  });

  it('does not let a negation re-include a file under an ignored directory', () => {
    write('.gitignore', 'gen/\n!gen/keep.ts\n');
    const ig = createIgnore(root);
    expect(ig('gen/keep.ts', false)).toBe(true);
  });
});
