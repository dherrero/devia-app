import * as path from 'node:path';
import type { LanguageResolver, ResolveContext } from '../language-resolvers';
import { dirOf, indexedFiles, normalizeRel } from './manifests';

// Maven/Gradle layouts and the bare project root: a class's file ends with `<fqn path>.java`
// under any of them, so matching on the path suffix covers every module of a multi-module build.
interface JavaIndex {
  byBase: Map<string, string[]>;
  byDir: Map<string, string[]>;
}

function pushTo(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const indexes = new WeakMap<ResolveContext, JavaIndex>();

function indexFor(ctx: ResolveContext): JavaIndex {
  let index = indexes.get(ctx);
  if (index) return index;
  index = { byBase: new Map(), byDir: new Map() };
  for (const f of indexedFiles(ctx)) {
    if (!f.endsWith('.java')) continue;
    const base = path.posix.basename(f);
    pushTo(index.byBase, base, f);
    const dir = dirOf(f);
    pushTo(index.byDir, dir, f);
  }
  indexes.set(ctx, index);
  return index;
}

function sharedPrefix(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  let n = 0;
  while (n < as.length - 1 && n < bs.length - 1 && as[n] === bs[n]) n++;
  return n;
}

/** Among `files`, the one closest to `fromFile` (same module); undefined when the best is tied. */
function closest(files: string[], fromFile: string): string | undefined {
  if (files.length <= 1) return files[0];
  const scored = files
    .map((f) => ({ f, score: sharedPrefix(f, fromFile) }))
    .sort((x, y) => y.score - x.score);
  const [best, next] = scored;
  return best && next && best.score > next.score ? best.f : undefined;
}

function classFile(
  parts: string[],
  fromFile: string,
  ctx: ResolveContext,
): string | undefined {
  const rel = `${parts.join('/')}.java`;
  const files = (
    indexFor(ctx).byBase.get(`${parts[parts.length - 1]}.java`) ?? []
  ).filter((f) => f === rel || f.endsWith(`/${rel}`));
  return closest(files, fromFile);
}

function packageFiles(
  parts: string[],
  fromFile: string,
  ctx: ResolveContext,
): string[] {
  const rel = parts.join('/');
  const matching: string[][] = [];
  for (const [dir, files] of indexFor(ctx).byDir)
    if (dir === rel || dir.endsWith(`/${rel}`)) matching.push(files);
  if (matching.length <= 1) return matching[0] ?? [];
  // Same package in several modules: only the importing module's copy counts.
  const sample = closest(
    matching.map((files) => files[0] ?? ''),
    fromFile,
  );
  return matching.find((files) => files[0] === sample) ?? [];
}

function resolveClass(
  fromFile: string,
  spec: string,
  ctx: ResolveContext,
): string | undefined {
  const parts = spec.split('.');
  if (parts.some((p) => p === '')) return undefined;
  // Nested classes and static members: progressively shorter prefixes (`a.b.Outer.Inner` → `a/b/Outer.java`).
  for (let n = parts.length; n >= 1; n--) {
    const hit = classFile(parts.slice(0, n), normalizeRel(fromFile), ctx);
    if (hit) return hit;
  }
  return undefined;
}

function resolveAll(
  fromFile: string,
  spec: string,
  ctx: ResolveContext,
  star: boolean,
): string[] {
  const from = normalizeRel(fromFile);
  if (star) {
    const files = packageFiles(spec.split('.'), from, ctx);
    if (files.length > 0) return [...files].sort();
  }
  const hit = resolveClass(from, spec, ctx);
  return hit === undefined ? [] : [hit];
}

export const javaResolver: LanguageResolver = {
  language: 'java',
  resolveImport: resolveClass,
  resolveImportAll: resolveAll,
};
