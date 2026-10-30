import { describe, it, expect } from 'vitest';
import { LineBuffer } from './line-buffer';

describe('LineBuffer', () => {
  it('push returns complete lines split on newline', () => {
    const buf = new LineBuffer();
    const lines = buf.push('hello\nworld\n');
    expect(lines).toEqual(['hello', 'world']);
  });

  it('push returns empty array for partial line with no newline', () => {
    const buf = new LineBuffer();
    const lines = buf.push('partial line');
    expect(lines).toHaveLength(0);
  });

  it('push accumulates partial lines across calls', () => {
    const buf = new LineBuffer();
    buf.push('hel');
    expect(buf.push('lo\n')).toEqual(['hello']);

    const buf2 = new LineBuffer();
    buf2.push('hel');
    const r = buf2.push('lo\n');
    expect(r).toEqual(['hello']);
  });

  it('drain returns and clears buffered partial content', () => {
    const buf = new LineBuffer();
    buf.push('partial');
    const drained = buf.drain();
    expect(drained).toBe('partial');
    // After drain, buffer is empty
    expect(buf.drain()).toBeNull();
  });

  it('drain returns null when buffer is empty', () => {
    const buf = new LineBuffer();
    expect(buf.drain()).toBeNull();
  });

  it('drain returns null when buffer only contains whitespace', () => {
    const buf = new LineBuffer();
    buf.push('   ');
    expect(buf.drain()).toBeNull();
  });

  it('push trims whitespace from lines', () => {
    const buf = new LineBuffer();
    const lines = buf.push('  hello  \n');
    expect(lines).toEqual(['hello']);
  });

  it('push ignores empty lines (whitespace-only between newlines)', () => {
    const buf = new LineBuffer();
    const lines = buf.push('line1\n  \nline2\n');
    // Whitespace-only line is trimmed to '' and excluded
    expect(lines).toEqual(['line1', 'line2']);
  });
});
