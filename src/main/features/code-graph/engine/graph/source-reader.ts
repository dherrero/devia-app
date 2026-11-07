import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPathContained } from '../../../../shared/workspace-paths';

export const MAX_RANGE_LINES = 400;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const STALE_FILE_NOTE =
  'file not found or changed since indexing — run graph_status';

export class PathRefusedError extends Error {
  readonly code = 'PATH_REFUSED';
  constructor(relPath: string) {
    super(`path refused: ${JSON.stringify(relPath)}`);
    this.name = 'PathRefusedError';
  }
}

const DRIVE_OR_UNC = /^(?:[a-zA-Z]:|[\\/]{2})/;

function resolveInside(root: string, relPath: string): string {
  if (relPath.includes('\0') || DRIVE_OR_UNC.test(relPath))
    throw new PathRefusedError(relPath);
  if (relPath.split(/[\\/]/).includes('..')) throw new PathRefusedError(relPath);
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, relPath);
  if (!isPathContained(abs, rootAbs)) throw new PathRefusedError(relPath);
  return abs;
}

/**
 * Reads lines `startLine..endLine` (1-based, inclusive) of a project file as LF text.
 * Throws only `PathRefusedError`; a vanished, oversized or unreadable file yields a note.
 */
export function readSourceRange(
  root: string,
  relPath: string,
  startLine: number,
  endLine: number,
): string {
  const abs = resolveInside(root, relPath);
  let real: string;
  try {
    const realRoot = fs.realpathSync(path.resolve(root));
    real = fs.realpathSync(abs);
    if (!isPathContained(real, realRoot)) throw new PathRefusedError(relPath);
  } catch (e) {
    if (e instanceof PathRefusedError) throw e;
    return STALE_FILE_NOTE;
  }

  let raw: string;
  try {
    const stat = fs.statSync(real);
    if (!stat.isFile()) return STALE_FILE_NOTE;
    if (stat.size > MAX_FILE_BYTES)
      return `file too large to show (${stat.size} bytes, cap ${MAX_FILE_BYTES})`;
    raw = fs.readFileSync(real, 'utf8');
  } catch {
    return STALE_FILE_NOTE;
  }

  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const start = Math.max(1, Math.floor(startLine));
  if (start > lines.length) return STALE_FILE_NOTE;
  const wanted = Math.floor(endLine) - start + 1;
  const count = Math.min(Math.max(wanted, 1), MAX_RANGE_LINES);
  const slice = lines.slice(start - 1, start - 1 + count);
  const text = slice.join('\n');
  return wanted > MAX_RANGE_LINES
    ? `${text}\n… truncated at ${MAX_RANGE_LINES} lines`
    : text;
}
