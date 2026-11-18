import type { LanguageResolver, ResolveContext } from '../language-resolvers';
import {
  dirOf,
  joinRel,
  manifestsByDir,
  nearestManifestDir,
  normalizeRel,
} from './manifests';

// Conditional imports/exports (`if (dart.library.io) '...'`) are not handled: only the default URI is seen.

export function pubspecName(text: string): string | undefined {
  const m = /^name:\s*["']?([\w.-]+)["']?\s*(?:#.*)?$/m.exec(text);
  return m?.[1];
}

function localPackageDir(
  name: string,
  fromFile: string,
  ctx: ResolveContext,
): string | undefined {
  const pubspecs = manifestsByDir(ctx, 'pubspec.yaml', ['.dart']);
  const own = nearestManifestDir(pubspecs, dirOf(fromFile));
  if (own !== undefined && pubspecName(pubspecs.get(own) ?? '') === name)
    return own;
  for (const [dir, text] of pubspecs)
    if (pubspecName(text) === name) return dir;
  return undefined;
}

function resolveDart(
  fromFile: string,
  spec: string,
  ctx: ResolveContext,
): string | undefined {
  const from = normalizeRel(fromFile);
  let target: string | undefined;
  const pkg = /^package:([^/]+)\/(.+)$/.exec(spec);
  if (pkg?.[1] && pkg[2]) {
    const dir = localPackageDir(pkg[1], from, ctx);
    target = dir === undefined ? undefined : joinRel(dir, `lib/${pkg[2]}`);
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(spec) && spec.endsWith('.dart')) {
    target = joinRel(dirOf(from), spec);
  }
  return target !== undefined && ctx.fileExists(target) ? target : undefined;
}

export const dartResolver: LanguageResolver = {
  language: 'dart',
  resolveImport: resolveDart,
};
