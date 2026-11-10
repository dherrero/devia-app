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

/** `*` stays inside one path segment, `**` spans segments; every other character is literal. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
