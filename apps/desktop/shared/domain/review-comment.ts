import type { DiffResult } from './git';

/**
 * Which gutter a commented line belongs to. A comment on an added/context
 * line anchors to `new` (its `newLineNo`); a deleted line anchors to `old`.
 */
export type ReviewSide = 'old' | 'new';

export interface ReviewComment {
  /** Absolute path, matching `DiffFile.path`. Stable key across re-fetches. */
  filePath: string;
  /** Line number on `side`. */
  line: number;
  side: ReviewSide;
  /**
   * Text of the anchored diff line at creation time. Used by
   * reconcileComments to detect when a commit/stash/edit shifted or replaced
   * the line, so a stale comment is never sent referencing a wrong line.
   */
  lineText: string;
  /** The user's comment. */
  text: string;
}

export interface ReviewPromptLabels {
  prefix: string;
  fileLabel: string;
  linePrefix: string;
  commentLabel: string;
}

/**
 * Builds the "revisa:" prompt injected into the chat composer. Pure: the
 * absolute→relative path mapping is supplied by the caller so this stays
 * free of renderer/workspace state and trivially testable.
 */
export function buildReviewPrompt(
  comments: readonly ReviewComment[],
  labels: ReviewPromptLabels,
  displayPath: (filePath: string) => string = (p) => p,
): string {
  if (comments.length === 0) return '';

  const sorted = [...comments].sort((a, b) => {
    const pa = displayPath(a.filePath);
    const pb = displayPath(b.filePath);
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.line - b.line;
  });

  const blocks = sorted.map((c) =>
    `${labels.fileLabel} ${displayPath(c.filePath)} ${labels.linePrefix}${c.line}\n`
    + `${labels.commentLabel} ${c.text.trim()}`,
  );

  return `${labels.prefix}\n${blocks.join('\n\n')}`;
}

/**
 * Deterministic fingerprint of a diff's content. Comments are valid only
 * against the snapshot they were written on; comparing signatures tells us
 * when the underlying diff changed (commit/stash/checkout/agent edit).
 * FNV-1a (not node:crypto) because `shared/` must stay portable between
 * main and renderer.
 */
export function diffSignature(diff: DiffResult): string {
  if (!diff.hasChanges) return 'empty';
  const parts: string[] = [];
  for (const f of diff.files) {
    parts.push(`F:${f.path}:${f.status}`);
    for (const l of f.lines) {
      parts.push(`${l.type}|${l.oldLineNo ?? ''}|${l.newLineNo ?? ''}|${l.text}`);
    }
  }
  return hashString(parts.join('\n'));
}

/**
 * Partitions comments by whether their anchored line still exists in `diff`
 * with the same text. Dropped comments are stale (line moved, changed, or
 * the file/diff is gone) and must not reach the agent.
 */
export function reconcileComments(
  comments: readonly ReviewComment[],
  diff: DiffResult,
): { kept: ReviewComment[]; dropped: ReviewComment[] } {
  const kept: ReviewComment[] = [];
  const dropped: ReviewComment[] = [];
  for (const c of comments) {
    if (commentResolves(c, diff)) kept.push(c);
    else dropped.push(c);
  }
  return { kept, dropped };
}

function commentResolves(c: ReviewComment, diff: DiffResult): boolean {
  if (!diff.hasChanges) return false;
  const file = diff.files.find((f) => f.path === c.filePath);
  if (!file) return false;
  return file.lines.some((l) =>
    l.type !== 'hunk'
    && (c.side === 'new' ? l.newLineNo === c.line : l.oldLineNo === c.line)
    && l.text === c.lineText,
  );
}

function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
