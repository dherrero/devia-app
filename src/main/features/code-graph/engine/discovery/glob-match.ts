/** One step of a path glob. `star` and `one` never cross a `/`; `any` does. */
export type GlobToken =
  | { kind: 'char'; c: string }
  | { kind: 'class'; re: RegExp }
  | { kind: 'one' }
  | { kind: 'star' }
  | { kind: 'any' }
  // `(?:.*/)?`: always followed by a `/` char token; the pair may also match nothing.
  | { kind: 'groupAny' };

/**
 * Up to this many unbounded wildcards a backtracking RegExp stays polynomial and small, and is
 * much faster than the simulation; beyond it a crafted `*a*a*a…` against a long path is
 * exponential, so the tokens are simulated as a set of positions (O(path × pattern)).
 */
const MAX_REGEXP_WILDCARDS = 2;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function toRegExp(tokens: GlobToken[]): RegExp {
  let re = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as GlobToken;
    if (t.kind === 'char') re += escapeRegex(t.c);
    else if (t.kind === 'class') re += t.re.source.slice(1, -1);
    else if (t.kind === 'one') re += '[^/]';
    else if (t.kind === 'star') re += '[^/]*';
    else if (t.kind === 'any') re += '.*';
    else {
      re += '(?:.*/)?';
      i++;
    }
  }
  return new RegExp(`^${re}$`, 'u');
}

function simulate(tokens: GlobToken[]): (subject: string) => boolean {
  const m = tokens.length;
  const close = (set: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
    for (let i = 0; i < m; i++) {
      if (!set[i]) continue;
      const t = tokens[i];
      if (t?.kind === 'star' || t?.kind === 'any') set[i + 1] = 1;
      else if (t?.kind === 'groupAny') {
        set[i + 1] = 1;
        set[i + 2] = 1;
      }
    }
    return set;
  };
  return (subject) => {
    let cur = new Uint8Array(m + 1);
    cur[0] = 1;
    close(cur);
    for (const c of subject) {
      const next = new Uint8Array(m + 1);
      let alive = false;
      for (let i = 0; i < m; i++) {
        if (!cur[i]) continue;
        const t = tokens[i] as GlobToken;
        if (t.kind === 'char') {
          if (t.c !== c) continue;
          next[i + 1] = 1;
        } else if (t.kind === 'class') {
          if (!t.re.test(c)) continue;
          next[i + 1] = 1;
        } else if (t.kind === 'one') {
          if (c === '/') continue;
          next[i + 1] = 1;
        } else if (t.kind === 'star') {
          if (c === '/') continue;
          next[i] = 1;
        } else next[i] = 1;
        alive = true;
      }
      if (!alive) return false;
      cur = close(next);
    }
    return cur[m] === 1;
  };
}

/** A whole-string matcher for `tokens` that never backtracks exponentially. */
export function compileGlobTokens(tokens: GlobToken[]): (subject: string) => boolean {
  const wildcards = tokens.filter((t) => t.kind === 'star' || t.kind === 'any' || t.kind === 'groupAny').length;
  if (wildcards <= MAX_REGEXP_WILDCARDS) {
    const re = toRegExp(tokens);
    return (subject) => re.test(subject);
  }
  return simulate(tokens);
}
