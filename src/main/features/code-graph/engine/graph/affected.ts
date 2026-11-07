import type { GraphQueries } from '../db/queries';
import { getImpact } from './traversal';

export interface AffectedOptions {
  depth?: number;
  /** Max production files returned in `files`. */
  limit?: number;
  includeTests?: boolean;
}

export interface AffectedResult {
  files: string[];
  tests: string[];
  unknown: string[];
  truncated: boolean;
}

const DEFAULT_LIMIT = 200;
const IMPACT_NODE_LIMIT = 300;

/** Root-relative `/` path, or undefined when it is absolute, escapes the root or holds a NUL. */
function normalise(input: string): string | undefined {
  if (input.includes('\0')) return undefined;
  const p = input.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return undefined;
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '..') return undefined;
    if (seg === '' || seg === '.') continue;
    parts.push(seg);
  }
  return parts.length > 0 ? parts.join('/') : undefined;
}

function split(file: string): { dir: string; base: string; ext: string } {
  const slash = file.lastIndexOf('/');
  const dir = slash === -1 ? '' : file.slice(0, slash);
  const name = file.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0
    ? { dir, base: name, ext: '' }
    : { dir, base: name.slice(0, dot), ext: name.slice(dot) };
}

const join = (...parts: string[]): string => parts.filter(Boolean).join('/');

function siblingCandidates(file: string): string[] {
  const { dir, base, ext } = split(file);
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mts':
    case '.cts':
    case '.mjs':
    case '.cjs':
      return [
        join(dir, `${base}.spec${ext}`),
        join(dir, `${base}.test${ext}`),
        join(dir, '__tests__', `${base}.test${ext}`),
        join(dir, '__tests__', `${base}.spec${ext}`),
      ];
    case '.go':
      return [join(dir, `${base}_test.go`)];
    case '.py':
      return [
        join(dir, `test_${base}.py`),
        join(dir, `${base}_test.py`),
        join(dir, 'tests', `test_${base}.py`),
        join('tests', `test_${base}.py`),
      ];
    case '.java': {
      const name = `${base}Test.java`;
      const out: string[] = [];
      const mirrored = `/${dir}/`.replace('/src/main/', '/src/test/');
      if (mirrored !== `/${dir}/`) out.push(join(mirrored.slice(1, -1), name));
      out.push(join(dir, name));
      return out;
    }
    case '.dart': {
      const name = `${base}_test.dart`;
      const out: string[] = [];
      if (dir === 'lib') out.push(join('test', name));
      else if (dir.startsWith('lib/'))
        out.push(join('test', dir.slice(4), name));
      out.push(join(dir, name), join(dir, 'test', name));
      return out;
    }
    default:
      return [];
  }
}

function rootIds(db: GraphQueries, file: string): string[] {
  const nodes = db.nodesInFile(file);
  const fileNode = nodes.find((n) => n.kind === 'file');
  return fileNode ? [fileNode.id] : nodes.map((n) => n.id);
}

export function getAffected(
  db: GraphQueries,
  changedFiles: string[],
  opts: AffectedOptions = {},
): AffectedResult {
  const depth = opts.depth ?? 2;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const includeTests = opts.includeTests ?? true;
  const indexed = new Set(db.filePaths());
  const testSet = db.testFilePaths();

  const unknown = new Set<string>();
  const changed: string[] = [];
  const seenChanged = new Set<string>();
  for (const input of changedFiles) {
    const p = normalise(input);
    if (p === undefined) unknown.add(input);
    else if (!indexed.has(p)) unknown.add(p);
    else if (!seenChanged.has(p)) {
      seenChanged.add(p);
      changed.push(p);
    }
  }

  const files = new Set<string>();
  const tests = new Set<string>();
  const place = (p: string): void => {
    if (testSet.has(p)) tests.add(p);
    else files.add(p);
  };

  for (const p of changed) place(p);
  let truncated = false;
  for (const p of changed) {
    if (files.size > limit) {
      truncated = true;
      break;
    }
    for (const id of rootIds(db, p)) {
      const impact = getImpact(db, id, { depth, limit: IMPACT_NODE_LIMIT });
      if (!impact) continue;
      if (impact.truncated) truncated = true;
      for (const f of impact.files) place(f);
    }
  }
  if (includeTests) {
    for (const p of changed) {
      if (testSet.has(p)) continue;
      for (const c of siblingCandidates(p)) if (testSet.has(c)) tests.add(c);
    }
  }

  let out = [...files];
  if (out.length > limit) {
    out = out.slice(0, limit);
    truncated = true;
  }
  return {
    files: out,
    tests: includeTests ? [...tests] : [],
    unknown: [...unknown],
    truncated,
  };
}
