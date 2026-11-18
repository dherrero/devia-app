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
  /** Non-source files to collect in `configs` (same ignore and symlink rules, no size checks). */
  isConfig?: (rel: string) => boolean;
  /** True when this size+mtime is already indexed: the minified probe is skipped for it. */
  isKnown?: (rel: string, size: number, mtimeMs: number) => boolean;
  maxFileBytes?: number;
  signal?: AbortSignal;
}

export interface DiscoverResult {
  files: DiscoveredFile[];
  configs: DiscoveredFile[];
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

type Entry =
  | { kind: 'file' | 'config'; file: DiscoveredFile }
  | { kind: 'dir' }
  | { kind: 'skip'; reason: SkipReason }
  | { kind: 'none' };

async function classifyEntry(
  abs: string,
  rel: string,
  ignore: (rel: string, isDir: boolean) => boolean,
  opts: Omit<DiscoverOptions, 'signal'>,
  maxBytes: number,
): Promise<Entry> {
  let st;
  try {
    st = await fs.lstat(abs);
  } catch {
    return { kind: 'skip', reason: 'unreadable' };
  }
  if (st.isSymbolicLink())
    return { kind: 'skip', reason: ignore(rel, false) ? 'ignored' : 'symlink' };
  const isDir = st.isDirectory();
  if (ignore(rel, isDir)) return { kind: 'skip', reason: 'ignored' };
  if (isDir) return { kind: 'dir' };
  if (!st.isFile()) return { kind: 'none' };
  const file: DiscoveredFile = { relPath: rel, absPath: abs, size: st.size, mtimeMs: st.mtimeMs };
  if (!opts.isSupported(rel)) return opts.isConfig?.(rel) ? { kind: 'config', file } : { kind: 'none' };
  if (st.size > maxBytes) return { kind: 'skip', reason: 'too-large' };
  if (opts.isKnown?.(rel, st.size, st.mtimeMs)) return { kind: 'file', file };
  try {
    if (await looksMinified(abs, st.size)) return { kind: 'skip', reason: 'minified' };
  } catch {
    return { kind: 'skip', reason: 'unreadable' };
  }
  return { kind: 'file', file };
}

export async function discoverFiles(
  root: string,
  opts: DiscoverOptions,
): Promise<DiscoverResult> {
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const files: DiscoveredFile[] = [];
  const configs: DiscoveredFile[] = [];
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
      const entry = await classifyEntry(path.join(dirAbs, name), rel, ignore, opts, maxBytes);
      if (entry.kind === 'dir') stack.push(rel);
      else if (entry.kind === 'file') files.push(entry.file);
      else if (entry.kind === 'config') configs.push(entry.file);
      else if (entry.kind === 'skip') skipped.push({ path: rel, reason: entry.reason });
    }
  }

  files.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  return { files, configs, skipped };
}

/**
 * Normalises a project path to its stored form (relative, `/`), or undefined if it leaves the root.
 * `paths` is the platform's path module; tests pass `path.win32` to check the Windows spelling.
 */
export function toProjectPath(
  root: string,
  p: string,
  paths: typeof path.posix = path,
): string | undefined {
  const abs = paths.resolve(root, p);
  const rel = paths.relative(paths.resolve(root), abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${paths.sep}`) || paths.isAbsolute(rel))
    return undefined;
  return rel.split(paths.sep).join('/');
}

/**
 * Applies the same rules as {@link discoverFiles} to just `paths`, without walking the tree:
 * every ancestor must be a real (non-symlink, non-ignored) directory inside the root.
 * Paths that no longer exist, and directories (they are never expanded), are absent from `files`.
 */
export async function discoverPaths(
  root: string,
  paths: string[],
  opts: Omit<DiscoverOptions, 'signal'>,
): Promise<DiscoverResult> {
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const ignore = createIgnore(root);
  const rootReal = await fs.realpath(root);
  const files: DiscoveredFile[] = [];
  const configs: DiscoveredFile[] = [];
  const skipped: DiscoverResult['skipped'] = [];
  const dirOk = new Map<string, boolean>();

  const ancestorsOk = async (segments: string[]): Promise<boolean> => {
    for (let i = 1; i < segments.length; i++) {
      const rel = segments.slice(0, i).join('/');
      let ok = dirOk.get(rel);
      if (ok === undefined) {
        const entry = await classifyEntry(path.join(root, ...segments.slice(0, i)), rel, ignore, opts, maxBytes);
        ok = entry.kind === 'dir';
        if (ok) {
          try {
            ok = isInside(rootReal, await fs.realpath(path.join(root, ...segments.slice(0, i))));
          } catch {
            ok = false;
          }
        }
        dirOk.set(rel, ok);
      }
      if (!ok) return false;
    }
    return true;
  };

  const seen = new Set<string>();
  for (const p of paths) {
    const rel = toProjectPath(root, p);
    if (rel === undefined || seen.has(rel)) continue;
    seen.add(rel);
    const segments = rel.split('/');
    if (!(await ancestorsOk(segments))) continue;
    const abs = path.join(root, ...segments);
    try {
      await fs.lstat(abs);
    } catch {
      continue;
    }
    const entry = await classifyEntry(abs, rel, ignore, opts, maxBytes);
    if (entry.kind === 'file') files.push(entry.file);
    else if (entry.kind === 'config') configs.push(entry.file);
    else if (entry.kind === 'skip') skipped.push({ path: rel, reason: entry.reason });
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { files, configs, skipped };
}
