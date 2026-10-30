import { describe, it, expect } from 'vitest';
import { BoundedLineBuffer } from './bounded-line-buffer';

describe('BoundedLineBuffer', () => {
  it('returns complete lines split on newline', () => {
    const buf = new BoundedLineBuffer();
    const { lines, overflow } = buf.push('hello\nworld\n');
    expect(lines).toEqual(['hello', 'world']);
    expect(overflow).toBe(false);
  });

  it('returns empty array for partial line with no newline', () => {
    const buf = new BoundedLineBuffer();
    const { lines, overflow } = buf.push('partial line');
    expect(lines).toHaveLength(0);
    expect(overflow).toBe(false);
  });

  it('accumulates partial lines across calls', () => {
    const buf = new BoundedLineBuffer();
    buf.push('hel');
    const { lines } = buf.push('lo\n');
    expect(lines).toEqual(['hello']);
  });

  it('drain returns remaining partial content', () => {
    const buf = new BoundedLineBuffer();
    buf.push('partial');
    expect(buf.drain()).toBe('partial');
    expect(buf.drain()).toBeNull();
  });

  it('drain returns null for empty buffer', () => {
    expect(new BoundedLineBuffer().drain()).toBeNull();
  });

  it('trims whitespace from lines', () => {
    const buf = new BoundedLineBuffer();
    const { lines } = buf.push('  hello  \n');
    expect(lines).toEqual(['hello']);
  });

  it('ignores whitespace-only lines', () => {
    const buf = new BoundedLineBuffer();
    const { lines } = buf.push('line1\n  \nline2\n');
    expect(lines).toEqual(['line1', 'line2']);
  });

  it('returns overflow: true when buffer exceeds maxBytes', () => {
    const buf = new BoundedLineBuffer(10);
    const { overflow } = buf.push('12345678901'); // 11 chars > 10
    expect(overflow).toBe(true);
    expect(buf.isOverflowed).toBe(true);
  });

  it('subsequent pushes after overflow return overflow: true', () => {
    const buf = new BoundedLineBuffer(5);
    buf.push('123456');
    const { overflow, lines } = buf.push('more\n');
    expect(overflow).toBe(true);
    expect(lines).toHaveLength(0);
  });

  it('drain returns null after overflow', () => {
    const buf = new BoundedLineBuffer(5);
    buf.push('123456');
    expect(buf.drain()).toBeNull();
  });

  // Property: chunk splits produce the same output as a single push
  it('same output regardless of how chunks are split', () => {
    const full = 'hello\nworld\nfoo\n';
    const bufA = new BoundedLineBuffer();
    const { lines: allAtOnce } = bufA.push(full);

    const bufB = new BoundedLineBuffer();
    const lines: string[] = [];
    for (const ch of full) {
      const { lines: l } = bufB.push(ch);
      lines.push(...l);
    }

    expect(lines).toEqual(allAtOnce);
  });
});
