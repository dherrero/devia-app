/** Tolerant NDJSON reader (handles the occasional pretty-printed startup frame). */
export function createJsonLineStream(onMessage: (message: unknown) => void) {
  let buffer = '';
  let pending = '';

  const tryEmit = (candidate: string): boolean => {
    try { onMessage(JSON.parse(candidate)); return true; } catch { return false; }
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (pending) {
      const candidate = `${pending}\n${trimmed}`;
      if (tryEmit(candidate)) { pending = ''; return; }
      if (candidate.length <= 128_000) { pending = candidate; return; }
      pending = '';
    }
    if (tryEmit(trimmed)) return;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) pending = trimmed;
  };

  return {
    feed(chunk: string): void {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    },
    flush(): void {
      if (buffer.trim()) handleLine(buffer);
      buffer = '';
      if (pending) { tryEmit(pending); pending = ''; }
    },
  };
}
