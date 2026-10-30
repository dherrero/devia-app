/**
 * Frame buffer for `\n\n`-delimited SSE-style streams.
 *
 * Accumulates input until a `\n\n` (or `\r\n\r\n`) boundary is found,
 * then yields one frame string per boundary. Enforces a byte cap to
 * guard against unbounded buffering.
 *
 * Parsers convert the `overflow` signal into a `PARSER_OVERFLOW` error event.
 */
export class JsonFrameBuffer {
  private buf = '';
  private overflowed = false;

  constructor(private readonly maxBytes = 1_048_576) {}

  push(chunk: string): { frames: string[]; overflow: boolean } {
    if (this.overflowed) return { frames: [], overflow: true };

    this.buf += typeof chunk === 'string' ? chunk : String(chunk);

    if (this.buf.length > this.maxBytes) {
      this.overflowed = true;
      this.buf = '';
      return { frames: [], overflow: true };
    }

    const frames: string[] = [];
    // Split on \n\n or \r\n\r\n boundaries.
    const boundary = /\r?\n\r?\n/;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.buf)) !== null) {
      const frame = this.buf.slice(0, match.index).trim();
      this.buf = this.buf.slice(match.index + match[0].length);
      if (frame.length > 0) frames.push(frame);
    }
    return { frames, overflow: false };
  }

  drain(): string | null {
    if (this.overflowed) return null;
    const rem = this.buf.trim();
    this.buf = '';
    return rem.length > 0 ? rem : null;
  }

  get isOverflowed(): boolean {
    return this.overflowed;
  }
}
