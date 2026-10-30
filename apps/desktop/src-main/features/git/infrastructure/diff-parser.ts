import type { DiffFile } from '../../../../shared/domain/git';

/**
 * Parses unified diff text (the output of `git diff --no-color`) into the
 * structured shape consumed by the renderer's PR-style viewer.
 */
export function parseUnifiedDiff(text: string, maxLinesPerFile: number): DiffFile[] {
  if (!text) return [];
  const out: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;
  let truncated = false;

  const lines = text.split('\n');
  for (const l of lines) {
    if (l.startsWith('diff --git')) {
      // Default path comes from the "diff --git a/X b/Y" header; the +++/---
      // pair below refines for adds/deletes. Strip the a/ b/ prefixes.
      const m = l.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = {
        path: m?.[2] ?? '',
        status: 'modified',
        lines: [],
      };
      out.push(current);
      truncated = false;
      continue;
    }
    if (!current) continue;

    if (l.startsWith('new file mode'))     { current.status = 'added';   continue; }
    if (l.startsWith('deleted file mode')) { current.status = 'deleted'; continue; }
    if (l.startsWith('rename from '))      { current.status = 'renamed'; current.oldPath = l.slice(12); continue; }
    if (l.startsWith('rename to '))        { current.path = l.slice(10); continue; }
    if (l.startsWith('index ')) continue;
    if (l.startsWith('--- ')) continue;
    if (l.startsWith('+++ ')) {
      const m = l.match(/^\+\+\+ b\/(.+)$/);
      if (m?.[1]) current.path = m[1];
      continue;
    }
    if (l.startsWith('Binary files')) {
      current.lines.push({ type: 'hunk', text: l });
      continue;
    }
    if (l.startsWith('@@ ')) {
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m?.[1] && m[2]) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      current.lines.push({ type: 'hunk', text: l });
      truncated = false;
      continue;
    }
    if (current.lines.length >= maxLinesPerFile) {
      if (!truncated) {
        current.lines.push({ type: 'hunk', text: '(diff recortado, demasiadas líneas)' });
        truncated = true;
      }
      continue;
    }
    if (l.startsWith('+')) {
      current.lines.push({ type: 'add', newLineNo: newLine++, text: l.slice(1) });
    } else if (l.startsWith('-')) {
      current.lines.push({ type: 'del', oldLineNo: oldLine++, text: l.slice(1) });
    } else if (l.startsWith(' ')) {
      current.lines.push({ type: 'context', oldLineNo: oldLine++, newLineNo: newLine++, text: l.slice(1) });
    }
    // Ignore any other prefix ("\ No newline at end of file", etc.)
  }

  return out;
}
