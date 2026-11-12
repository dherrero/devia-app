import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileGlobTokens, type GlobToken } from './glob-match';

const DEFAULT_IGNORES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.dart_tool',
  '.idea',
  '.vscode',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
  'target',
  'coverage',
  '.next',
  '.angular',
];

interface Rule {
  test: (rel: string) => boolean;
  negate: boolean;
  dirOnly: boolean;
}

// A .gitignore comes with the (possibly hostile) repository: its globs are matched without a
// backtracking RegExp once they hold several wildcards (see compileGlobTokens).
function globTokens(pattern: string): GlobToken[] {
  const glob = Array.from(pattern);
  const out: GlobToken[] = [];
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] ?? '';
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        const next = glob[i + 2];
        if (atStart && next === '/') {
          out.push({ kind: 'groupAny' }, { kind: 'char', c: '/' });
          i += 3;
          continue;
        }
        if (atStart && next === undefined) {
          out.push({ kind: 'any' });
          i += 2;
          continue;
        }
        out.push({ kind: 'star' });
        i += 2;
        continue;
      }
      out.push({ kind: 'star' });
      i += 1;
    } else if (c === '?') {
      out.push({ kind: 'one' });
      i += 1;
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) {
        out.push({ kind: 'char', c: '[' });
        i += 1;
      } else {
        let body = glob.slice(i + 1, end).join('');
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        out.push(classToken(body.replace(/\\/g, '\\\\')));
        i = end + 1;
      }
    } else if (c === '\\' && i + 1 < glob.length) {
      out.push({ kind: 'char', c: glob[i + 1] ?? '' });
      i += 2;
    } else {
      out.push({ kind: 'char', c });
      i += 1;
    }
  }
  return out;
}

function classToken(body: string): GlobToken {
  try {
    return { kind: 'class', re: new RegExp(`^[${body}]$`, 'u') };
  } catch {
    // Not a valid class (e.g. a reversed range): git matches nothing there either.
    return { kind: 'class', re: /^(?!)$/u };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function parseLine(raw: string): Rule | null {
  let line = raw.replace(/\r$/, '');
  line = line.replace(/(?<!\\)\s+$/, '');
  if (line === '' || line.startsWith('#')) return null;
  let negate = false;
  if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  }
  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.replace(/\/+$/, '');
  }
  if (line === '') return null;
  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);
  const tokens = globTokens(line);
  const all: GlobToken[] = anchored ? tokens : [{ kind: 'groupAny' }, { kind: 'char', c: '/' }, ...tokens];
  return { test: compileGlobTokens(all), negate, dirOnly };
}

function parseIgnoreFile(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split('\n')) {
    const rule = parseLine(raw);
    if (rule) rules.push(rule);
  }
  return rules;
}

function evaluate(
  rules: ReadonlyArray<Rule>,
  rel: string,
  isDir: boolean,
  current: boolean,
): boolean {
  let result = current;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.test(rel)) result = !rule.negate;
  }
  return result;
}

export function createIgnore(
  root: string,
): (rel: string, isDir: boolean) => boolean {
  const defaults: Rule[] = DEFAULT_IGNORES.map((name) => {
    const re = new RegExp(`^(?:.*/)?${escapeRegex(name)}$`, 'u');
    return { test: (rel: string) => re.test(rel), negate: false, dirOnly: false };
  });
  const fileCache = new Map<string, Rule[]>();

  const rulesFor = (dirRel: string): Rule[] => {
    const cached = fileCache.get(dirRel);
    if (cached) return cached;
    let rules: Rule[] = [];
    try {
      const text = fs.readFileSync(
        path.join(root, ...dirRel.split('/').filter(Boolean), '.gitignore'),
        'utf8',
      );
      rules = parseIgnoreFile(text);
    } catch {
      rules = [];
    }
    fileCache.set(dirRel, rules);
    return rules;
  };

  const check = (segments: string[], isDir: boolean): boolean => {
    const rel = segments.join('/');
    if (segments.includes('.git')) return true;
    if (segments.length > 1 && check(segments.slice(0, -1), true)) return true;
    let ignored = evaluate(defaults, rel, isDir, false);
    for (let depth = 0; depth < segments.length; depth++) {
      const dirRel = segments.slice(0, depth).join('/');
      const sub = segments.slice(depth).join('/');
      ignored = evaluate(rulesFor(dirRel), sub, isDir, ignored);
    }
    return ignored;
  };

  return (rel, isDir) => {
    const segments = rel
      .replace(/\\/g, '/')
      .split('/')
      .filter((s) => s !== '' && s !== '.');
    if (segments.length === 0) return false;
    return check(segments, isDir);
  };
}
