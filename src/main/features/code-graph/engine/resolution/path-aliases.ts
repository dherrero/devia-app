import * as fs from 'node:fs';
import * as path from 'node:path';

// Adapted from codegraph (MIT), src/resolution/path-aliases.ts: tsconfig/jsconfig `paths` +
// `baseUrl` with relative `extends`, nearest config per directory. Paths are root-relative, `/`.

export interface PathAlias {
  pattern: string;
  prefix: string;
  suffix: string;
  wildcard: boolean;
  targets: string[];
}

export interface PathConfig {
  /** Root-relative directory `baseUrl` points at, when set. */
  baseUrl?: string;
  /** Directory the `paths` targets are relative to (baseUrl, else the defining config's dir). */
  pathsBase: string;
  aliases: PathAlias[];
}

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];
const MAX_EXTENDS_DEPTH = 10;

/** JSON with comments and trailing commas (tsconfig dialect). Undefined when unparseable. */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(
      stripTrailingCommas(stripComments(text.replace(/^\uFEFF/, ''))),
    );
  } catch {
    return undefined;
  }
}

function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? '')) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '"') return i + 1;
    else i++;
  }
  return text.length;
}

/** Joins and normalises a root-relative path; undefined when it escapes the root. */
export function joinInRoot(dir: string, rel: string): string | undefined {
  const joined = path.posix.normalize(
    path.posix.join(dir, rel.replace(/\\/g, '/')),
  );
  if (
    joined === '..' ||
    joined.startsWith('../') ||
    path.posix.isAbsolute(joined)
  )
    return undefined;
  return joined === '.' ? '' : joined.replace(/\/$/, '');
}

interface RawConfig {
  extends?: unknown;
  references?: unknown;
  compilerOptions?: { baseUrl?: unknown; paths?: unknown };
}

interface Resolved {
  baseUrl?: string;
  paths?: { value: Record<string, unknown>; dir: string };
}

/**
 * Per-run cache of tsconfig lookups. Created per resolution run so an edited tsconfig is
 * picked up by the next run.
 */
export class PathConfigCache {
  private readonly byDir = new Map<string, PathConfig | undefined>();
  private readonly byFile = new Map<string, PathConfig | undefined>();

  constructor(private readonly root: string) {}

  /** Nearest tsconfig.json/jsconfig.json walking up from the file's directory. */
  forFile(fromFile: string): PathConfig | undefined {
    const dir = path.posix.dirname(fromFile);
    return this.forDir(dir === '.' ? '' : dir);
  }

  private forDir(dir: string): PathConfig | undefined {
    if (this.byDir.has(dir)) return this.byDir.get(dir);
    let found: PathConfig | undefined;
    let located = false;
    for (const name of CONFIG_NAMES) {
      const rel = dir ? `${dir}/${name}` : name;
      if (!this.exists(rel)) continue;
      located = true;
      found = this.load(rel);
      break;
    }
    if (!located && dir !== '') {
      const parent = path.posix.dirname(dir);
      found = this.forDir(parent === '.' ? '' : parent);
    }
    this.byDir.set(dir, found);
    return found;
  }

  private load(rel: string): PathConfig | undefined {
    if (this.byFile.has(rel)) return this.byFile.get(rel);
    let resolved = this.resolve(rel, new Set(), 0);
    if (resolved && !resolved.paths && resolved.baseUrl === undefined) {
      resolved = this.fromReferences(rel) ?? resolved;
    }
    const config = resolved ? toPathConfig(resolved) : undefined;
    this.byFile.set(rel, config);
    return config;
  }

  private fromReferences(rel: string): Resolved | undefined {
    const raw = this.read(rel);
    if (!raw || !Array.isArray(raw.references)) return undefined;
    const dir = path.posix.dirname(rel);
    for (const ref of raw.references as unknown[]) {
      const refPath = (ref as { path?: unknown } | null)?.path;
      if (typeof refPath !== 'string') continue;
      let target = joinInRoot(dir === '.' ? '' : dir, refPath);
      if (target === undefined) continue;
      if (!target.endsWith('.json')) target = `${target}/tsconfig.json`;
      const resolved = this.resolve(target, new Set([rel]), 1);
      if (resolved?.paths || resolved?.baseUrl !== undefined) return resolved;
    }
    return undefined;
  }

  private resolve(
    rel: string,
    seen: Set<string>,
    depth: number,
  ): Resolved | undefined {
    if (seen.has(rel) || depth > MAX_EXTENDS_DEPTH) return undefined;
    seen.add(rel);
    const raw = this.read(rel);
    if (!raw) return undefined;
    const dirOf = path.posix.dirname(rel);
    const dir = dirOf === '.' ? '' : dirOf;

    const result: Resolved = {};
    const parents =
      typeof raw.extends === 'string'
        ? [raw.extends]
        : Array.isArray(raw.extends)
          ? raw.extends
          : [];
    for (const parent of parents) {
      if (typeof parent !== 'string' || !/^\.\.?(\/|$)/.test(parent)) continue;
      let target = joinInRoot(dir, parent);
      if (target === undefined) continue;
      if (!target.endsWith('.json')) target = `${target}.json`;
      const inherited = this.resolve(target, seen, depth + 1);
      if (inherited?.baseUrl !== undefined) result.baseUrl = inherited.baseUrl;
      if (inherited?.paths) result.paths = inherited.paths;
    }

    const options = raw.compilerOptions;
    if (options && typeof options === 'object') {
      if (typeof options.baseUrl === 'string') {
        const base = joinInRoot(dir, options.baseUrl);
        if (base !== undefined) result.baseUrl = base;
      }
      if (
        options.paths &&
        typeof options.paths === 'object' &&
        !Array.isArray(options.paths)
      ) {
        result.paths = { value: options.paths as Record<string, unknown>, dir };
      }
    }
    return result;
  }

  private read(rel: string): RawConfig | undefined {
    try {
      const parsed = parseJsonc(
        fs.readFileSync(path.join(this.root, rel), 'utf8'),
      );
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as RawConfig)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private exists(rel: string): boolean {
    try {
      return fs.statSync(path.join(this.root, rel)).isFile();
    } catch {
      return false;
    }
  }
}

function toPathConfig(r: Resolved): PathConfig {
  const pathsBase = r.baseUrl ?? r.paths?.dir ?? '';
  const aliases: PathAlias[] = [];
  for (const [pattern, value] of Object.entries(r.paths?.value ?? {})) {
    if (!Array.isArray(value)) continue;
    const targets = value.filter((t): t is string => typeof t === 'string');
    const star = pattern.indexOf('*');
    if (star !== pattern.lastIndexOf('*')) continue;
    aliases.push({
      pattern,
      prefix: star < 0 ? pattern : pattern.slice(0, star),
      suffix: star < 0 ? '' : pattern.slice(star + 1),
      wildcard: star >= 0,
      targets,
    });
  }
  const config: PathConfig = { pathsBase, aliases };
  if (r.baseUrl !== undefined) config.baseUrl = r.baseUrl;
  return config;
}

/** Root-relative candidate bases (no extension resolution) for a `paths` match, longest prefix wins. */
export function matchPathAlias(spec: string, config: PathConfig): string[] {
  let best: { alias: PathAlias; captured: string } | undefined;
  for (const alias of config.aliases) {
    if (!alias.wildcard) {
      if (spec === alias.pattern) {
        best = { alias, captured: '' };
        break;
      }
      continue;
    }
    if (
      spec.length >= alias.prefix.length + alias.suffix.length &&
      spec.startsWith(alias.prefix) &&
      spec.endsWith(alias.suffix) &&
      (!best || alias.prefix.length > best.alias.prefix.length)
    ) {
      best = {
        alias,
        captured: spec.slice(
          alias.prefix.length,
          spec.length - alias.suffix.length,
        ),
      };
    }
  }
  if (!best) return [];
  const { alias, captured } = best;
  return alias.targets.flatMap((t) => {
    const joined = joinInRoot(config.pathsBase, t.replace('*', captured));
    return joined === undefined ? [] : [joined];
  });
}
