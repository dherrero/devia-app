import { ancestorDirs, dirOf, joinRel, manifestsByDir } from './manifests';
import type { ResolveContext } from '../language-resolvers';

/** A Go module (or a relative `replace` target) mapped to the directory that holds it. */
export interface GoModule {
  module: string;
  dir: string;
}

function stripComment(line: string): string {
  const i = line.indexOf('//');
  return (i >= 0 ? line.slice(0, i) : line).trim();
}

function unquote(s: string): string {
  return s.replace(/^["`]|["`]$/g, '');
}

/** `module` and the relative-directory `replace` directives of a go.mod (`dir` = its directory). */
export function parseGoMod(text: string, dir: string): GoModule[] {
  const out: GoModule[] = [];
  let inReplace = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line) continue;
    const mod = /^module\s+(\S+)/.exec(line);
    if (mod?.[1]) {
      out.push({ module: unquote(mod[1]), dir });
      continue;
    }
    let body: string | undefined;
    if (inReplace) {
      if (line === ')') inReplace = false;
      else body = line;
    } else if (/^replace\s*\(/.test(line)) {
      inReplace = true;
    } else if (line.startsWith('replace ')) {
      body = line.slice('replace '.length);
    }
    if (body === undefined) continue;
    const [from, to] = body.split('=>').map((s) => s.trim());
    const source = from?.split(/\s+/)[0];
    const target = to?.split(/\s+/)[0];
    if (!source || !target || !/^\.\.?(\/|\\|$)/.test(unquote(target)))
      continue;
    const targetDir = joinRel(dir, unquote(target));
    if (targetDir !== undefined)
      out.push({ module: unquote(source), dir: targetDir });
  }
  return out;
}

const cache = new WeakMap<ResolveContext, GoModule[]>();

export function goModules(ctx: ResolveContext): GoModule[] {
  const hit = cache.get(ctx);
  if (hit) return hit;
  const modules: GoModule[] = [];
  for (const [dir, text] of manifestsByDir(ctx, 'go.mod', ['.go']))
    modules.push(...parseGoMod(text, dir));
  cache.set(ctx, modules);
  return modules;
}

/** Directory of an import path under the longest matching module prefix. */
export function goImportDir(
  spec: string,
  ctx: ResolveContext,
): string | undefined {
  let best: GoModule | undefined;
  for (const m of goModules(ctx)) {
    if (spec !== m.module && !spec.startsWith(`${m.module}/`)) continue;
    if (!best || m.module.length > best.module.length) best = m;
  }
  if (!best) return undefined;
  const rest = spec.slice(best.module.length + 1);
  return rest ? joinRel(best.dir, rest) : best.dir;
}

/** `a/internal/x` is importable only from inside `a/`. */
export function internalAllowed(fromFile: string, targetDir: string): boolean {
  const segs = targetDir.split('/');
  const at = segs.lastIndexOf('internal');
  if (at < 0) return true;
  const parent = segs.slice(0, at).join('/');
  return ancestorDirs(dirOf(fromFile)).includes(parent);
}
