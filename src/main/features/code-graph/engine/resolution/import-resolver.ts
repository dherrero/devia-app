// Adapted from codegraph (MIT) — see NOTICE
import * as path from 'node:path';
import type { CodeGraphLanguage } from '../../../../../shared/domain/code-graph';
import type { LanguageResolver, ResolveContext } from './language-resolvers';
import { joinInRoot, matchPathAlias, PathConfigCache } from './path-aliases';

// Upstream codegraph: src/resolution/import-resolver.ts (TS/JS part only).

const EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.d.ts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];
const KNOWN_EXTENSION = /\.(d\.ts|[cm]?[jt]sx?)$/;
const ESM_SOURCES: Readonly<Record<string, string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

// One config cache per resolution run: the context object is created once per run.
const configCaches = new WeakMap<ResolveContext, PathConfigCache>();

function configCache(ctx: ResolveContext): PathConfigCache {
  let cache = configCaches.get(ctx);
  if (!cache) {
    cache = new PathConfigCache(ctx.root);
    configCaches.set(ctx, cache);
  }
  return cache;
}

/** `base` (root-relative, maybe with extension) → indexed file, trying TS/JS extensions then `index.*`. */
export function resolveModuleFile(
  base: string,
  ctx: ResolveContext,
): string | undefined {
  const ext = path.posix.extname(base);
  const esm = ESM_SOURCES[ext];
  if (esm) {
    const stem = base.slice(0, -ext.length);
    for (const e of esm) if (ctx.fileExists(stem + e)) return stem + e;
  }
  if (KNOWN_EXTENSION.test(base) && ctx.fileExists(base)) return base;
  for (const e of EXTENSIONS) if (ctx.fileExists(base + e)) return base + e;
  const index = base ? `${base}/index` : 'index';
  for (const e of EXTENSIONS) if (ctx.fileExists(index + e)) return index + e;
  return undefined;
}

function resolveTsImport(
  fromFile: string,
  spec: string,
  ctx: ResolveContext,
): string | undefined {
  if (spec.startsWith('.')) {
    const dir = path.posix.dirname(fromFile);
    const base = joinInRoot(dir === '.' ? '' : dir, spec);
    return base === undefined ? undefined : resolveModuleFile(base, ctx);
  }
  if (spec.startsWith('/') || /^[a-z]+:/i.test(spec)) return undefined;
  const config = configCache(ctx).forFile(fromFile);
  if (!config) return undefined;
  for (const candidate of matchPathAlias(spec, config)) {
    const hit = resolveModuleFile(candidate, ctx);
    if (hit) return hit;
  }
  if (config.baseUrl !== undefined) {
    const base = joinInRoot(config.baseUrl, spec);
    if (base !== undefined) return resolveModuleFile(base, ctx);
  }
  return undefined;
}

function tsFamilyResolver(language: CodeGraphLanguage): LanguageResolver {
  return { language, resolveImport: resolveTsImport };
}

export const typescriptResolver = tsFamilyResolver('typescript');
export const javascriptResolver = tsFamilyResolver('javascript');
