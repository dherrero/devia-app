import { describe, expect, it } from 'vitest';
import { capOutput, compileGlob, MAX_OUTPUT_CHARS } from './format';

describe('capOutput', () => {
  it('leaves short output untouched', () => {
    expect(capOutput('a\nb', 100)).toBe('a\nb');
  });

  it('cuts at a line boundary and says how many lines were dropped', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
    const out = capOutput(lines.join('\n'), 300);
    expect(out.length).toBeLessThanOrEqual(300);
    const kept = out.split('\n');
    const marker = kept.pop();
    expect(lines.slice(0, kept.length)).toEqual(kept);
    expect(marker).toBe(`… output truncated (${50 - kept.length} more lines) — narrow the query`);
  });

  it('closes a code fence left open by the cut', () => {
    const body = ['## x', '```', ...Array.from({ length: 40 }, (_, i) => `code ${i}`), '```', 'after'].join('\n');
    const out = capOutput(body, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toMatch(/\n```\n… output truncated/);
  });

  it('defaults to 24 000 characters', () => {
    expect(MAX_OUTPUT_CHARS).toBe(24_000);
    expect(capOutput('y\n'.repeat(20_000)).length).toBeLessThanOrEqual(24_000);
  });
});

describe('compileGlob', () => {
  const m = (glob: string, subject: string): boolean => compileGlob(glob)(subject);

  it('matches * within a segment, ** across segments and escapes the rest', () => {
    expect(m('*.ts', 'a.ts')).toBe(true);
    expect(m('*.ts', 'a.tsx')).toBe(false);
    expect(m('src/*.ts', 'src/x/a.ts')).toBe(false);
    expect(m('src/**/*.ts', 'src/x/y/a.ts')).toBe(true);
    expect(m('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(m('src/**', 'src/a/b.ts')).toBe(true);
    expect(m('**/*.test.ts', 'a.test.ts')).toBe(true);
    expect(m('**/*.test.ts', 'x/y/a.test.ts')).toBe(true);
    expect(m('src/**/*.ts', 'srcx/a.ts')).toBe(false);
    expect(m('a+b(c).ts', 'a+b(c).ts')).toBe(true);
    expect(m('a.ts', 'axts')).toBe(false);
    expect(m('[ab]?.ts', '[ab]?.ts')).toBe(true);
    expect(m('*', '')).toBe(true);
    expect(m('', '')).toBe(true);
    expect(m('', 'a')).toBe(false);
    expect(m('😀*.ts', '😀x.ts')).toBe(true);
    expect(m('?.ts', '😀.ts')).toBe(false);
  });

  it('keeps the same semantics past the RegExp fast path (3+ wildcards)', () => {
    expect(m('**/src/**/*.ts', 'a/src/b/c.ts')).toBe(true);
    expect(m('**/src/**/*.ts', 'src/c.ts')).toBe(true);
    expect(m('**/src/**/*.ts', 'src/c.tsx')).toBe(false);
    expect(m('*/*/*.ts', 'a/b/c.ts')).toBe(true);
    expect(m('*/*/*.ts', 'a/c.ts')).toBe(false);
    expect(m('a**b**c', 'a/x/b/y/c')).toBe(true);
    expect(m('a**b**c', 'a/x/b/y/d')).toBe(false);
  });

  it('stays linear on a crafted **x**x… pattern that would backtrack exponentially as a RegExp', () => {
    const glob = `${'**x'.repeat(40)}y`;
    const subject = 'x'.repeat(4000);
    const start = performance.now();
    expect(m(glob, subject)).toBe(false);
    expect(m(`${'*x'.repeat(40)}y`, subject)).toBe(false);
    // O(path × pattern) = 4000 × 81 steps: milliseconds. A backtracking RegExp never returns.
    expect(performance.now() - start).toBeLessThan(5000);
  });
});
