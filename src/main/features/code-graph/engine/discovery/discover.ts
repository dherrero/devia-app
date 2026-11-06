import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createIgnore } from './ignore';

export interface DiscoveredFile {
  relPath: string;
  absPath: string;
  size: number;
  mtimeMs: number;
}

export type SkipReason =
  'ignored' | 'too-large' | 'symlink' | 'minified' | 'unreadable';

export interface DiscoverOptions {
  isSupported: (rel: string) => boolean;
  maxFileBytes?: number;
  signal?: AbortSignal;
}

export interface DiscoverResult {
  files: DiscoveredFile[];
  skipped: { path: string; reason: SkipReason }[];
}

const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const MINIFIED_SAMPLE_BYTES = 64 * 1024;
const MINIFIED_MAX_LINE = 10_000;
const MINIFIED_AVG_MIN_SIZE = 50_000;
const MINIFIED_AVG_LINE = 300;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new DOMException('Discovery aborted', 'AbortError');
}

async function looksMinified(absPath: string, size: number): Promise<boolean> {
  const handle = await fs.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, MINIFIED_SAMPLE_BYTES));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, bytesRead);
    const lines = text.split('\n');
    let longest = 0;
    for (const line of lines) if (line.length > longest) longest = line.length;
    if (longest > MINIFIED_MAX_LINE) return true;
    return (
      size > MINIFIED_AVG_MIN_SIZE &&
      text.length / lines.length > MINIFIED_AVG_LINE
    );
  } finally {
    await handle.close();
  }
}

function isInside(rootReal: string, dirReal: string): boolean {
  return (
    dirReal === rootReal ||
    dirReal.startsWith(
      rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep,
    )
  );
}

export async function discoverFiles(
  root: string,
  opts: DiscoverOptions,
): Promise<DiscoverResult> {
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const files: DiscoveredFile[] = [];
  const skipped: DiscoverResult['skipped'] = [];
  const ignore = createIgnore(root);
  const rootReal = await fs.realpath(root);
  const stack: string[] = [''];

  while (stack.length > 0) {
    throwIfAborted(opts.signal);
    const dirRel = stack.pop() as string;
    const dirAbs = dirRel === '' ? root : path.join(root, ...dirRel.split('/'));
    let names: string[];
    try {
      const real = await fs.realpath(dirAbs);
      if (!isInside(rootReal, real)) {
        skipped.push({ path: dirRel, reason: 'symlink' });
        continue;
      }
      names = await fs.readdir(dirAbs);
    } catch {
      skipped.push({ path: dirRel, reason: 'unreadable' });
      continue;
    }

    for (const name of names) {
      throwIfAborted(opts.signal);
      const rel = dirRel === '' ? name : `${dirRel}/${name}`;
      const abs = path.join(dirAbs, name);
      let st;
      try {
        st = await fs.lstat(abs);
      } catch {
        skipped.push({ path: rel, reason: 'unreadable' });
        continue;
      }
      if (st.isSymbolicLink()) {
        skipped.push({
          path: rel,
          reason: ignore(rel, false) ? 'ignored' : 'symlink',
        });
        continue;
      }
      const isDir = st.isDirectory();
      if (ignore(rel, isDir)) {
        skipped.push({ path: rel, reason: 'ignored' });
        continue;
      }
      if (isDir) {
        stack.push(rel);
        continue;
      }
      if (!st.isFile() || !opts.isSupported(rel)) continue;
      if (st.size > maxBytes) {
        skipped.push({ path: rel, reason: 'too-large' });
        continue;
      }
      try {
        if (await looksMinified(abs, st.size)) {
          skipped.push({ path: rel, reason: 'minified' });
          continue;
        }
      } catch {
        skipped.push({ path: rel, reason: 'unreadable' });
        continue;
      }
      files.push({
        relPath: rel,
        absPath: abs,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }

  files.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  return { files, skipped };
}
