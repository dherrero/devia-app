import { describe, it, expect } from 'vitest';
import { JsonFrameBuffer } from './json-frame-buffer';

describe('JsonFrameBuffer', () => {
  it('returns frames split on \\n\\n boundary', () => {
    const buf = new JsonFrameBuffer();
    const { frames, overflow } = buf.push('frame1\n\nframe2\n\n');
    expect(frames).toEqual(['frame1', 'frame2']);
    expect(overflow).toBe(false);
  });

  it('returns empty array for partial frame with no boundary', () => {
    const buf = new JsonFrameBuffer();
    const { frames } = buf.push('partial frame');
    expect(frames).toHaveLength(0);
  });

  it('accumulates partial frames across calls', () => {
    const buf = new JsonFrameBuffer();
    buf.push('fra');
    buf.push('me1');
    const { frames } = buf.push('\n\n');
    expect(frames).toEqual(['frame1']);
  });

  it('handles \\r\\n\\r\\n boundary', () => {
    const buf = new JsonFrameBuffer();
    const { frames } = buf.push('frame1\r\n\r\nframe2\r\n\r\n');
    expect(frames).toEqual(['frame1', 'frame2']);
  });

  it('drain returns remaining partial content', () => {
    const buf = new JsonFrameBuffer();
    buf.push('partial');
    expect(buf.drain()).toBe('partial');
    expect(buf.drain()).toBeNull();
  });

  it('drain returns null for empty buffer', () => {
    expect(new JsonFrameBuffer().drain()).toBeNull();
  });

  it('returns overflow: true when buffer exceeds maxBytes', () => {
    const buf = new JsonFrameBuffer(10);
    const { overflow } = buf.push('12345678901');
    expect(overflow).toBe(true);
    expect(buf.isOverflowed).toBe(true);
  });

  it('subsequent pushes after overflow return overflow: true', () => {
    const buf = new JsonFrameBuffer(5);
    buf.push('123456');
    const { overflow, frames } = buf.push('more\n\n');
    expect(overflow).toBe(true);
    expect(frames).toHaveLength(0);
  });

  it('drain returns null after overflow', () => {
    const buf = new JsonFrameBuffer(5);
    buf.push('123456');
    expect(buf.drain()).toBeNull();
  });

  it('skips empty frames between consecutive boundaries', () => {
    const buf = new JsonFrameBuffer();
    const { frames } = buf.push('a\n\n\n\nb\n\n');
    expect(frames).toEqual(['a', 'b']);
  });
});
