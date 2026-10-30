/**
 * Reusable newline-delimited buffer. The launcher feeds `data` chunks
 * straight off the child's stdout (which Node delivers split anywhere —
 * mid-line, mid-character, etc.); this gives each parser a clean
 * line-at-a-time stream and a final `drain()` on close to surface any
 * trailing fragment.
 */
export class LineBuffer {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) lines.push(line);
    }
    return lines;
  }

  drain(): string | null {
    const rem = this.buf.trim();
    this.buf = '';
    return rem.length > 0 ? rem : null;
  }
}
