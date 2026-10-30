/**
 * Newline-delimited buffer with an explicit byte cap.
 *
 * Like LineBuffer but raises an overflow signal when the internal
 * accumulator exceeds `maxBytes` without finding a newline. Parsers
 * convert that signal into a `PARSER_OVERFLOW` error event.
 *
 * The cap guards against a provider that never emits newlines (e.g. a
 * runaway stdout) filling the process heap.
 */
export class BoundedLineBuffer {
  private buf = '';
  private overflowed = false;

  constructor(private readonly maxBytes = 1_048_576) {}

  /**
   * Push a chunk and return complete lines plus an overflow flag.
   * Once overflow is true, all subsequent pushes return `{ lines: [], overflow: true }`.
   */
  push(chunk: string): { lines: string[]; overflow: boolean } {
    if (this.overflowed) return { lines: [], overflow: true };

    this.buf += typeof chunk === 'string' ? chunk : String(chunk);

    if (this.buf.length > this.maxBytes) {
      this.overflowed = true;
      this.buf = '';
      return { lines: [], overflow: true };
    }

    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) lines.push(line);
    }
    return { lines, overflow: false };
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
