import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveReferences } from '../resolution/resolver';
import { createHarness, type Harness } from '../resolution/test-support';
import { exploreSymbols } from './explore';
import { bestOf, perfBudget, mkEdge, mkNode, openTempDb, seedGraph } from './test-graph';

const FILES: Record<string, string> = {
  'src/a.ts': `import { mid } from './mid';
export class A {
  start(): number {
    return mid();
  }
}
`,
  'src/mid.ts': `import { B } from './b';
export function mid(): number {
  return B.finish();
}
`,
  'src/b.ts': `export class B {
  static finish(): number {
    return 42;
  }
}
`,
  'src/r1.ts': `export class Runner {
  run(): string {
    return 'runner';
  }
}
`,
  'src/r2.ts': `export class Task {
  run(): string {
    return 'task';
  }
}
`,
  'src/lonely.ts': `export function lonely(): number {
  return 1;
}
`,
};

let h: Harness;

beforeEach(async () => {
  h = createHarness();
  await h.addFiles(FILES);
  resolveReferences(h.q, h.root);
});

afterEach(() => h.close());

describe('exploreSymbols', () => {
  it('finds the flow between named symbols', () => {
    const r = exploreSymbols(h.q, h.root, 'A.start B.finish');
    expect(r.flow).toHaveLength(1);
    expect(r.flow[0]?.map((n) => n.name)).toEqual(['start', 'mid', 'finish']);
    expect(r.unresolvedNames).toEqual([]);
    expect(r.found).toBe(2);
    expect(r.markdown).toMatch(/Flow/);
    expect(r.markdown).toContain('A.start');
    expect(r.markdown).toContain('→');
    expect(r.markdown).toContain('src/mid.ts:2');
    expect(r.markdown.indexOf('Flow')).toBeLessThan(
      r.markdown.indexOf('Sources'),
    );
  });

  it('finds the flow when the names are given in reverse order', () => {
    const r = exploreSymbols(h.q, h.root, 'B.finish A.start');
    expect(r.flow[0]?.map((n) => n.name)).toEqual(['start', 'mid', 'finish']);
  });

  it('sorts files with named symbols first and includes bodies', () => {
    const r = exploreSymbols(h.q, h.root, 'B.finish A.start');
    const paths = r.files.map((f) => f.path);
    expect(new Set(paths.slice(0, 2))).toEqual(new Set(['src/a.ts', 'src/b.ts']));
    expect(paths[2]).toBe('src/mid.ts');
    const b = r.files.find((f) => f.path === 'src/b.ts');
    expect(b?.snippets[0]?.text).toContain('return 42');
    expect(b?.snippets[0]?.startLine).toBe(2);
  });

  it('reports an unknown name without throwing', () => {
    const r = exploreSymbols(h.q, h.root, 'A.start NopeNotThere');
    expect(r.unresolvedNames).toEqual(['NopeNotThere']);
    expect(r.found).toBe(1);
    expect(r.markdown).toContain('NopeNotThere');
    expect(r.markdown).toMatch(/graph_explore|graph_node/);
  });

  it('answers an empty query and all-unknown queries success-shaped', () => {
    const e = exploreSymbols(h.q, h.root, '   ');
    expect(e.found).toBe(0);
    expect(e.files).toEqual([]);
    expect(e.markdown.length).toBeGreaterThan(0);
    const u = exploreSymbols(h.q, h.root, 'zzz yyy');
    expect(u.unresolvedNames).toEqual(['zzz', 'yyy']);
    expect(u.markdown).toMatch(/graph_explore|graph_node/);
  });

  it('contributes every overload of an ambiguous name', () => {
    const r = exploreSymbols(h.q, h.root, 'run');
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain('src/r1.ts');
    expect(paths).toContain('src/r2.ts');
    expect(r.found).toBe(1);
  });

  it('survives a file deleted after indexing', () => {
    fs.rmSync(path.join(h.root, 'src/b.ts'));
    const r = exploreSymbols(h.q, h.root, 'A.start B.finish');
    const b = r.files.find((f) => f.path === 'src/b.ts');
    expect(b?.snippets[0]?.text).toContain(
      'file not found or changed since indexing — run graph_status',
    );
  });

  it('never tells the agent to read or grep', () => {
    for (const q of ['A.start B.finish', 'nope', '', 'lonely run']) {
      const md = exploreSymbols(h.q, h.root, q).markdown;
      expect(md).not.toMatch(/use Read|run grep|use grep|\bRead\b the/i);
      expect(md).not.toMatch(/\bgrep\b/i);
    }
  });

  it('does not wander through an unnamed god-function bridge', () => {
    const nodes = [
      mkNode('x'),
      mkNode('hub'),
      mkNode('y'),
      ...Array.from({ length: 30 }, (_, i) => mkNode(`leaf${i}`)),
    ];
    const edges = [
      mkEdge('x', 'hub'),
      mkEdge('hub', 'y'),
      ...Array.from({ length: 30 }, (_, i) => mkEdge('hub', `leaf${i}`)),
    ];
    const t = openTempDb();
    try {
      seedGraph(t.q, nodes, edges);
      const r = exploreSymbols(t.q, h.root, 'x y');
      expect(r.flow).toEqual([]);
    } finally {
      t.close();
    }
  });

  it('keeps the output within the budget', () => {
    const r = exploreSymbols(h.q, h.root, 'A.start B.finish run lonely');
    expect(r.markdown.length).toBeLessThanOrEqual(18_000);
  });

  it('skips an escaping indexed path with a note and keeps the other sources', () => {
    const t = openTempDb();
    try {
      seedGraph(
        t.q,
        [
          mkNode('evil', { filePath: '../../etc/passwd' }),
          mkNode('fine', { filePath: 'src/lonely.ts', startLine: 1, endLine: 3 }),
        ],
        [],
      );
      const r = exploreSymbols(t.q, h.root, 'evil fine');
      expect(r.files.find((f) => f.path === 'src/lonely.ts')?.snippets[0]?.text).toContain('lonely');
      expect(r.markdown).toContain('path outside the project root — skipped');
    } finally {
      t.close();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'skips a file replaced by a symlink outside the root after indexing',
    () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-out-'));
      try {
        fs.writeFileSync(path.join(outside, 'x.ts'), 'secret');
        fs.rmSync(path.join(h.root, 'src/b.ts'));
        fs.symlinkSync(path.join(outside, 'x.ts'), path.join(h.root, 'src/b.ts'));
        const r = exploreSymbols(h.q, h.root, 'A.start B.finish');
        expect(r.markdown).toContain('path outside the project root — skipped');
        expect(r.markdown).not.toContain('secret');
        expect(r.files.find((f) => f.path === 'src/a.ts')).toBeDefined();
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('answers a 5-symbol query over a 50k-node graph in under 1 s', () => {
    const t = openTempDb();
    try {
      const nodes = Array.from({ length: 50_000 }, (_, i) =>
        mkNode(`n${i}`, { filePath: `src/f${i % 500}.ts`, startLine: i, endLine: i + 1 }),
      );
      const edges = Array.from({ length: 49_999 }, (_, i) =>
        mkEdge(`n${i}`, `n${i + 1}`),
      );
      seedGraph(t.q, nodes, edges);
      const run = bestOf(() => exploreSymbols(t.q, h.root, 'n0 n3 n6 n9 n12'));
      expect(run.value.found).toBe(5);
      expect(run.ms).toBeLessThan(perfBudget(1000));
    } finally {
      t.close();
    }
  }, 120_000);

  it('keeps a short named body when a long neighbour sits above it', async () => {
    const pad = Array.from({ length: 200 }, (_, i) => `  total += ${i}; // padding line ${i}`).join('\n');
    await h.addFiles({
      'src/mix.ts': `export function bigHelper(): number {\n  let total = 0;\n${pad}\n  return total;\n}\n\nexport function target(): number {\n  return bigHelper() + 1;\n}\n`,
    });
    resolveReferences(h.q, h.root);
    const r = exploreSymbols(h.q, h.root, 'target');
    const file = r.files.find((f) => f.path === 'src/mix.ts');
    const texts = file?.snippets.map((s) => s.text).join('\n') ?? '';
    expect(texts).toContain('return bigHelper() + 1;');
  });

  it('truncates a long named body with an explicit marker and a true endLine', async () => {
    const pad = Array.from({ length: 500 }, (_, i) => `  total += ${i};`).join('\n');
    await h.addFiles({
      'src/huge.ts': `export function huge(): number {\n  let total = 0;\n${pad}\n  return total;\n}\n`,
    });
    const r = exploreSymbols(h.q, h.root, 'huge');
    const snip = r.files.find((f) => f.path === 'src/huge.ts')?.snippets[0];
    expect(snip?.text).toMatch(/… truncated \(\d+ more lines\) — call graph_node for the full body/);
    const shown = snip?.text.split('\n').filter((l) => !l.startsWith('…')).length ?? 0;
    expect(snip?.endLine).toBe((snip?.startLine ?? 0) + shown - 1);
    expect(snip?.endLine).toBeLessThan(504);
    const more = Number(/\((\d+) more lines\)/.exec(snip?.text ?? '')?.[1]);
    expect((snip?.endLine ?? 0) + more).toBe(504);
  });

  it('always shows every named file even past maxFiles', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++)
      files[`src/n${i}.ts`] = `export function named${i}(): number {\n  return ${i};\n}\n`;
    await h.addFiles(files);
    const r = exploreSymbols(h.q, h.root, 'named0 named1 named2 named3 named4 named5');
    expect(r.files.map((f) => f.path).sort()).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => `src/n${i}.ts`),
    );
    expect(r.markdown.length).toBeLessThanOrEqual(18_000);
  });

  it('fences code that itself contains triple backticks', async () => {
    await h.addFiles({
      'src/md.ts': 'export function md(): string {\n  return "```js\\nx\\n```";\n}\n',
    });
    const r = exploreSymbols(h.q, h.root, 'md');
    expect(r.markdown).toContain('````\nexport function md');
  });

  it('emits one stale note per file', () => {
    fs.rmSync(path.join(h.root, 'src/r1.ts'));
    const r = exploreSymbols(h.q, h.root, 'Runner Runner.run');
    const f = r.files.find((x) => x.path === 'src/r1.ts');
    expect(f?.snippets).toHaveLength(1);
    expect(r.markdown.split('run graph_status').length - 1).toBe(1);
  });
});
