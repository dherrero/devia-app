import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * NOTICE ↔ source headers (S-44 T-514). Every file adapted from codegraph
 * (MIT) carries the header line below and is listed in NOTICE, and every file
 * NOTICE lists still exists and carries the line: attribution must not drift
 * when files are added, renamed or rewritten.
 */
const ROOT = path.resolve(__dirname, '..');
const FEATURE = path.join(ROOT, 'src', 'main', 'features', 'code-graph');
const HEADER = 'Adapted from codegraph (MIT) — see NOTICE';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__fixtures__' ? [] : sourceFiles(p);
    return /\.(ts|sql)$/.test(e.name) && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('NOTICE attribution of the code graph', () => {
  const notice = readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
  const listed = [...notice.matchAll(/^\s+(src\/main\/features\/code-graph\/\S+)$/gm)].map((m) => m[1] ?? '');
  const marked = sourceFiles(FEATURE)
    .filter((f) => readFileSync(f, 'utf8').split('\n').slice(0, 3).some((l) => l.includes(HEADER)))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .sort();

  it('lists exactly the files whose header says they were adapted from codegraph', () => {
    expect(marked.length).toBeGreaterThan(0);
    expect([...listed].sort()).toEqual(marked);
  });

  it('keeps the codegraph license text and every vendored grammar', () => {
    expect(notice).toContain('Copyright (c) 2026 Colby Mchenry');
    expect(notice).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    const wasmDir = path.join(FEATURE, 'engine', 'extraction', 'wasm');
    for (const wasm of readdirSync(wasmDir).filter((f) => f.endsWith('.wasm'))) expect(notice).toContain(wasm);
  });
});
