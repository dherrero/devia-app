import type { LanguageResolver, ResolveContext } from '../language-resolvers';
import { goImportDir, internalAllowed } from './go-mod';
import { dirOf, normalizeRel } from './manifests';

// Windows paths are normalised; vendored, stdlib and external paths stay unresolved.

function packageFiles(
  fromFile: string,
  spec: string,
  ctx: ResolveContext,
): string[] {
  const dir = goImportDir(spec, ctx);
  if (dir === undefined || !internalAllowed(normalizeRel(fromFile), dir))
    return [];
  return ctx
    .listFiles()
    .filter(
      (f) => f.endsWith('.go') && !f.endsWith('_test.go') && dirOf(f) === dir,
    )
    .sort();
}

export const goResolver: LanguageResolver = {
  language: 'go',
  resolveImport: (fromFile, spec, ctx) => packageFiles(fromFile, spec, ctx)[0],
  resolveImportAll: (fromFile, spec, ctx) => packageFiles(fromFile, spec, ctx),
};
