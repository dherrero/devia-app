import * as path from 'node:path';
import type { ResolveContext } from '../language-resolvers';

export function normalizeRel(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\/?$/, '');
}

export function dirOf(file: string): string {
  const dir = path.posix.dirname(normalizeRel(file));
  return dir === '.' ? '' : dir;
}

export function joinRel(dir: string, rel: string): string | undefined {
  const joined = path.posix.normalize(
    dir ? `${dir}/${rel.replace(/\\/g, '/')}` : rel.replace(/\\/g, '/'),
  );
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/'))
    return undefined;
  return joined === '.' ? '' : joined;
}

export function ancestorDirs(dir: string): string[] {
  const out: string[] = [];
  let current = dir;
  for (;;) {
    out.push(current);
    if (current === '') return out;
    const next = path.posix.dirname(current);
    current = next === '.' ? '' : next;
  }
}

const fileLists = new WeakMap<ResolveContext, string[]>();

/** `ctx.listFiles()` once per resolution run (it may copy a large list). */
export function indexedFiles(ctx: ResolveContext): string[] {
  let files = fileLists.get(ctx);
  if (!files) fileLists.set(ctx, (files = ctx.listFiles()));
  return files;
}

const cache = new WeakMap<ResolveContext, Map<string, Map<string, string>>>();

/**
 * Manifest files (`go.mod`, `pubspec.yaml`) are not indexed, so they are probed in every
 * directory that is, or contains, an indexed source file with one of `extensions`.
 * Keyed by directory (root-relative, '' = root); computed once per resolution run.
 */
export function manifestsByDir(
  ctx: ResolveContext,
  manifest: string,
  extensions: string[],
): Map<string, string> {
  let perCtx = cache.get(ctx);
  if (!perCtx) cache.set(ctx, (perCtx = new Map()));
  const hit = perCtx.get(manifest);
  if (hit) return hit;
  const dirs = new Set<string>();
  for (const f of indexedFiles(ctx))
    if (extensions.some((e) => f.endsWith(e)))
      for (const d of ancestorDirs(dirOf(f))) {
        if (dirs.has(d)) break;
        dirs.add(d);
      }
  const found = new Map<string, string>();
  for (const d of dirs) {
    const text = ctx.readText?.(d ? `${d}/${manifest}` : manifest);
    if (text !== undefined) found.set(d, text);
  }
  perCtx.set(manifest, found);
  return found;
}

/** Nearest manifest directory at or above `fromDir`. */
export function nearestManifestDir(
  manifests: Map<string, string>,
  fromDir: string,
): string | undefined {
  return ancestorDirs(fromDir).find((d) => manifests.has(d));
}
