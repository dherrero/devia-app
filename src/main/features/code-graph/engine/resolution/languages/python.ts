import * as path from 'node:path';
import type { LanguageResolver, ResolveContext } from '../language-resolvers';
import { ancestorDirs, dirOf, joinRel, normalizeRel } from './manifests';

/** `base` (root-relative, no extension) → `base.py(i)` or `base/__init__.py(i)`. */
export function pythonModuleCandidates(base: string): string[] {
  const init = base ? `${base}/__init__` : '__init__';
  return [`${base}.py`, `${base}.pyi`, `${init}.py`, `${init}.pyi`].filter(
    (c) => !c.startsWith('.py'),
  );
}

/** The package itself (`from . import y`): only its `__init__`, never a sibling `<dir>.py`. */
function initOnly(dir: string, ctx: ResolveContext): string | undefined {
  const init = dir ? `${dir}/__init__` : '__init__';
  return [`${init}.py`, `${init}.pyi`].find((c) => ctx.fileExists(c));
}

function firstExisting(base: string, ctx: ResolveContext): string | undefined {
  return pythonModuleCandidates(base).find((c) => ctx.fileExists(c));
}

/**
 * Directories absolute imports are resolved from: the project root, `src/`, and the directory
 * holding the importing file's top-level package (nearest ancestor without `__init__.py`).
 */
function packageRoots(fromFile: string, ctx: ResolveContext): string[] {
  const roots = ['', 'src'];
  for (const dir of ancestorDirs(dirOf(fromFile))) {
    if (!ctx.fileExists(dir ? `${dir}/__init__.py` : '__init__.py')) {
      roots.push(dir);
      break;
    }
  }
  return [...new Set(roots)];
}

function relativeBase(
  fromFile: string,
  spec: string,
): { dir: string; rest: string } | undefined {
  const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
  let dir = dirOf(fromFile);
  for (let i = 1; i < dots; i++) {
    if (dir === '') return undefined;
    dir = path.posix.dirname(dir) === '.' ? '' : path.posix.dirname(dir);
  }
  return { dir, rest: spec.slice(dots).replace(/\./g, '/') };
}

function resolvePython(
  fromFile: string,
  spec: string,
  ctx: ResolveContext,
): string | undefined {
  const from = normalizeRel(fromFile);
  if (spec.startsWith('.')) {
    const rel = relativeBase(from, spec);
    if (!rel) return undefined;
    if (!rel.rest) return initOnly(rel.dir, ctx);
    const base = joinRel(rel.dir, rel.rest);
    return base === undefined ? undefined : firstExisting(base, ctx);
  }
  const parts = spec.split('.');
  if (parts.some((p) => p === '')) return undefined;
  // Longest module first; a shorter prefix wins when the tail is an attribute (`import a.Thing`).
  for (let n = parts.length; n >= 1; n--) {
    const rel = parts.slice(0, n).join('/');
    for (const root of packageRoots(from, ctx)) {
      const base = joinRel(root, rel);
      const hit = base === undefined ? undefined : firstExisting(base, ctx);
      if (hit) return hit;
    }
  }
  return undefined;
}

function resolveSubmodule(
  fromFile: string,
  spec: string,
  imported: string,
  ctx: ResolveContext,
): string | undefined {
  if (imported === '*' || imported.includes('.')) return undefined;
  const from = normalizeRel(fromFile);
  if (spec.startsWith('.')) {
    const rel = relativeBase(from, spec);
    if (!rel) return undefined;
    const sub = joinRel(
      rel.dir,
      rel.rest ? `${rel.rest}/${imported}` : imported,
    );
    return sub === undefined ? undefined : firstExisting(sub, ctx);
  }
  for (const root of packageRoots(from, ctx)) {
    const sub = joinRel(root, `${spec.replace(/\./g, '/')}/${imported}`);
    const hit = sub === undefined ? undefined : firstExisting(sub, ctx);
    if (hit) return hit;
  }
  return undefined;
}

export const pythonResolver: LanguageResolver = {
  language: 'python',
  resolveImport: resolvePython,
  resolveSubmodule,
};
