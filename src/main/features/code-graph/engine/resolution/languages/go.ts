import type { LanguageResolver, ResolveContext } from '../language-resolvers';
import { goImportDir, internalAllowed } from './go-mod';
import { dirOf, indexedFiles, normalizeRel } from './manifests';

// Windows paths are normalised; vendored, stdlib and external paths stay unresolved.

const packageIndexes = new WeakMap<ResolveContext, Map<string, string[]>>();

/** dir → sorted non-test `.go` files, built once per resolution run. */
function packageIndex(ctx: ResolveContext): Map<string, string[]> {
  let index = packageIndexes.get(ctx);
  if (index) return index;
  index = new Map();
  for (const f of indexedFiles(ctx)) {
    if (!f.endsWith('.go') || f.endsWith('_test.go')) continue;
    const dir = dirOf(f);
    const list = index.get(dir);
    if (list) list.push(f);
    else index.set(dir, [f]);
  }
  for (const list of index.values()) list.sort();
  packageIndexes.set(ctx, index);
  return index;
}

function packageFiles(
  fromFile: string,
  spec: string,
  ctx: ResolveContext,
): string[] {
  const dir = goImportDir(spec, ctx);
  if (dir === undefined || !internalAllowed(normalizeRel(fromFile), dir))
    return [];
  return packageIndex(ctx).get(dir) ?? [];
}

export const goResolver: LanguageResolver = {
  language: 'go',
  resolveImport: (fromFile, spec, ctx) => packageFiles(fromFile, spec, ctx)[0],
  resolveImportAll: (fromFile, spec, ctx) => packageFiles(fromFile, spec, ctx),
};
