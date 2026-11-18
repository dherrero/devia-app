import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPathContained } from '../../../../shared/workspace-paths';

export const MAX_RANGE_LINES = 400;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const REFUSED_FILE_NOTE = 'path outside the project root — skipped';
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

type Loaded = { lines: string[] } | { note: string };

function loadLines(root: string, relPath: string): Loaded {
  const abs = resolveInside(root, relPath);
  let real: string;
  try {
    const realRoot = fs.realpathSync(path.resolve(root));
    real = fs.realpathSync(abs);
    if (!isPathContained(real, realRoot)) throw new PathRefusedError(relPath);
  } catch (e) {
    if (e instanceof PathRefusedError) throw e;
    return { note: STALE_FILE_NOTE };
  }

  let raw: string;
  try {
    const stat = fs.statSync(real);
    if (!stat.isFile()) return { note: STALE_FILE_NOTE };
    if (stat.size > MAX_FILE_BYTES)
      return {
        note: `file too large to show (${stat.size} bytes, cap ${MAX_FILE_BYTES})`,
      };
    raw = fs.readFileSync(real, 'utf8');
  } catch {
    return { note: STALE_FILE_NOTE };
  }

  const lines = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return { lines };
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
  const loaded = loadLines(root, relPath);
  if ('note' in loaded) return loaded.note;
  const { lines } = loaded;
  const start = Math.max(1, Math.floor(startLine));
  if (start > lines.length) return STALE_FILE_NOTE;
  const wanted = Math.floor(endLine) - start + 1;
  const count = Math.min(Math.max(wanted, 1), MAX_RANGE_LINES);
  const text = lines.slice(start - 1, start - 1 + count).join('\n');
  return wanted > MAX_RANGE_LINES
    ? `${text}\n… truncated at ${MAX_RANGE_LINES} lines`
    : text;
}

export type RangeRead =
  | {
      ok: true;
      text: string;
      startLine: number;
      /** Last line actually included in `text`. */
      endLine: number;
      /** Requested lines beyond `endLine` (range over the 400-line cap). */
      moreLines: number;
    }
  | { ok: false; note: string };

export interface SourceReader {
  read(relPath: string, startLine: number, endLine: number): RangeRead;
}

/** Reads each file once per reader and never throws: a refused path becomes a note. */
export function createSourceReader(root: string): SourceReader {
  const cache = new Map<string, Loaded>();
  const load = (relPath: string): Loaded => {
    let loaded = cache.get(relPath);
    if (!loaded) {
      try {
        loaded = loadLines(root, relPath);
      } catch (e) {
        if (!(e instanceof PathRefusedError)) throw e;
        loaded = { note: REFUSED_FILE_NOTE };
      }
      cache.set(relPath, loaded);
    }
    return loaded;
  };
  return {
    read(relPath, startLine, endLine) {
      const loaded = load(relPath);
      if ('note' in loaded) return { ok: false, note: loaded.note };
      const { lines } = loaded;
      const start = Math.max(1, Math.floor(startLine));
      if (start > lines.length) return { ok: false, note: STALE_FILE_NOTE };
      const wantedEnd = Math.min(
        Math.max(Math.floor(endLine), start),
        lines.length,
      );
      const shownEnd = Math.min(wantedEnd, start + MAX_RANGE_LINES - 1);
      return {
        ok: true,
        text: lines.slice(start - 1, shownEnd).join('\n'),
        startLine: start,
        endLine: shownEnd,
        moreLines: wantedEnd - shownEnd,
      };
    },
  };
}
