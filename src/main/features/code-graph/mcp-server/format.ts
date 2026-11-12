import type { GraphNode } from '../../../../shared/domain/code-graph';

export const MAX_OUTPUT_CHARS = 24_000;

const FENCE = /^(`{3,})/;

function truncationMarker(more: number): string {
  return `… output truncated (${more} more lines) — narrow the query`;
}

/** Fence still open after `lines`, so a cut inside a code block can be closed. */
function openFence(lines: string[]): string | undefined {
  let open: string | undefined;
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (!m?.[1]) continue;
    if (open === undefined) open = m[1];
    else if (line.trim() === open) open = undefined;
  }
  return open;
}

/** Cuts `text` at a line boundary so the result, marker included, fits in `max` characters. */
export function capOutput(text: string, max: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const lines = text.split('\n');
  let kept = 0;
  let used = 0;
  // Room for the marker, a closing fence and their newlines.
  const reserve = truncationMarker(lines.length).length + 16;
  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > max - reserve) break;
    used += cost;
    kept++;
  }
  const out = lines.slice(0, kept);
  const fence = openFence(out);
  if (fence !== undefined) out.push(fence);
  out.push(truncationMarker(lines.length - kept));
  return out.join('\n');
}

export function location(n: Pick<GraphNode, 'filePath' | 'startLine'>): string {
  return `${n.filePath}:${n.startLine}`;
}

export function ref(n: GraphNode): string {
  return n.kind === 'file' ? `${n.filePath} (top-level code)` : `${n.qualifiedName} (${location(n)})`;
}

export function heading(n: GraphNode): string {
  return `\`${n.qualifiedName}\` (${n.kind}) — ${location(n)}`;
}

type GlobToken =
  | { kind: 'char'; c: string }
  | { kind: 'star' }
  | { kind: 'any' }
  // The `.*` of a `**/` group; the group (it and the next `/`) may also match nothing.
  | { kind: 'groupAny' };

function tokenizeGlob(pattern: string): GlobToken[] {
  // By code point, like the subject loop, so an emoji is one literal on both sides.
  const glob = Array.from(pattern);
  const out: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        out.push({ kind: 'groupAny' }, { kind: 'char', c: '/' });
      } else out.push({ kind: 'any' });
    } else if (c === '*') out.push({ kind: 'star' });
    else out.push({ kind: 'char', c });
  }
  return out;
}

// `*` stays inside one path segment, `**` spans segments, `**/` may also match nothing; every other
// character is literal. Simulated as a set of pattern positions (O(path × pattern)), never a
// backtracking RegExp: a crafted `**x**x**x…` against a long path would be exponential there.
export function compileGlob(glob: string): (subject: string) => boolean {
  const tokens = tokenizeGlob(glob);
  const m = tokens.length;
  const close = (set: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
    for (let i = 0; i < m; i++) {
      if (!set[i]) continue;
      const t = tokens[i];
      if (t?.kind === 'star' || t?.kind === 'any') set[i + 1] = 1;
      else if (t?.kind === 'groupAny') {
        set[i + 1] = 1;
        set[i + 2] = 1;
      }
    }
    return set;
  };
  return (subject) => {
    let cur = new Uint8Array(m + 1);
    cur[0] = 1;
    close(cur);
    for (const c of subject) {
      const next = new Uint8Array(m + 1);
      let alive = false;
      for (let i = 0; i < m; i++) {
        if (!cur[i]) continue;
        const t = tokens[i];
        if (t === undefined) continue;
        if (t.kind === 'char') {
          if (t.c !== c) continue;
          next[i + 1] = 1;
        } else if (t.kind === 'star') {
          if (c === '/') continue;
          next[i] = 1;
        } else next[i] = 1;
        alive = true;
      }
      if (!alive) return false;
      cur = close(next);
    }
    return cur[m] === 1;
  };
}
