/**
 * Minimal frontmatter parser for `PACK.md` files (REV-AGENT-CORE-003).
 *
 * We deliberately avoid pulling a YAML dependency. The supported subset:
 *   - delimiter: `---` on its own line at the top, closed by another `---`.
 *   - key: value (string)
 *   - key: [item1, item2, "with spaces"]  (string array; supports inline JSON-ish)
 *   - blank lines and `# comments` inside the frontmatter are ignored.
 *
 * Anything outside this subset is silently dropped. The body below the closing
 * delimiter is returned verbatim with leading whitespace trimmed.
 *
 * Pure — no I/O. Returns `null` when no frontmatter is detected (body = the
 * whole input).
 */

export interface ParsedFrontmatter {
  meta: Record<string, string | string[]>;
  body: string;
}

const DELIM = '---';

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.replace(/^\uFEFF/, ''); // strip BOM
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== DELIM) {
    return { meta: {}, body: text.trimStart() };
  }
  // Find the closing delimiter.
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === DELIM) { close = i; break; }
  }
  if (close === -1) {
    // Unclosed frontmatter — treat as plain body.
    return { meta: {}, body: text.trimStart() };
  }

  const meta: Record<string, string | string[]> = {};
  for (let i = 1; i < close; i++) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (key.length === 0) continue;

    // Array form: [a, b, "c, with comma"]
    if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = parseInlineArray(value);
      continue;
    }

    // Strip surrounding quotes.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }

  const body = lines.slice(close + 1).join('\n').trimStart();
  return { meta, body };
}

function parseInlineArray(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return [];
  // Honour quoted segments so commas inside quotes are preserved.
  const out: string[] = [];
  let buf = '';
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; continue; }
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    if (ch === ',') {
      const v = buf.trim();
      if (v.length > 0) out.push(v);
      buf = '';
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}
