import { describe, expect, it } from 'vitest';
import { capOutput, globToRegExp, MAX_OUTPUT_CHARS } from './format';

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

describe('globToRegExp', () => {
  it('matches * within a segment, ** across segments and escapes the rest', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('a.tsx')).toBe(false);
    expect(globToRegExp('src/*.ts').test('src/x/a.ts')).toBe(false);
    expect(globToRegExp('src/**/*.ts').test('src/x/y/a.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('a+b(c).ts').test('a+b(c).ts')).toBe(true);
    expect(globToRegExp('a.ts').test('axts')).toBe(false);
  });
});
