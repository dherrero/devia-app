import * as fs from 'node:fs';
import * as path from 'node:path';

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
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function globToRegex(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob.charAt(i + 1) === '*') {
        const atStart = i === 0 || glob.charAt(i - 1) === '/';
        const next = glob.charAt(i + 2);
        if (atStart && next === '/') {
          out += '(?:.*/)?';
          i += 3;
          continue;
        }
        if (atStart && next === '') {
          out += '.*';
          i += 2;
          continue;
        }
        out += '[^/]*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) {
        out += '\\[';
        i += 1;
      } else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        out += `[${body.replace(/\\/g, '\\\\')}]`;
        i = end + 1;
      }
    } else if (c === '\\' && i + 1 < glob.length) {
      out += escapeRegex(glob.charAt(i + 1));
      i += 2;
    } else {
      out += escapeRegex(c);
      i += 1;
    }
  }
  return out;
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
  const body = globToRegex(line);
  const re = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`, 'u');
  return { re, negate, dirOnly };
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
    if (rule.re.test(rel)) result = !rule.negate;
  }
  return result;
}

export function createIgnore(
  root: string,
): (rel: string, isDir: boolean) => boolean {
  const defaults: Rule[] = DEFAULT_IGNORES.map((name) => ({
    re: new RegExp(`^(?:.*/)?${escapeRegex(name)}$`, 'u'),
    negate: false,
    dirOnly: false,
  }));
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
