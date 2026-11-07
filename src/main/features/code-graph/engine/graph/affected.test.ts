import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GraphNode } from '../../../../../shared/domain/code-graph';
import { isTestFile } from '../discovery/test-detection';
import { languageForPath } from '../extraction/grammars';
import { createHarness, type Harness } from '../resolution/test-support';
import { resolveReferences } from '../resolution/resolver';
import { getAffected } from './affected';
import {
  bestOf,
  mkEdge,
  mkNode,
  openTempDb,
  seedGraph,
  type SeededDb,
} from './test-graph';

async function indexFiles(
  h: Harness,
  files: Record<string, string>,
): Promise<void> {
  await h.addFiles(files);
  for (const rel of Object.keys(files)) {
    const language = languageForPath(rel);
    if (!language) continue;
    h.q.upsertFile({
      path: rel,
      contentHash: 'h',
      language,
      size: 1,
      modifiedAt: 1,
      indexedAt: 1,
      nodeCount: 0,
      generated: false,
      isTest: isTestFile(rel, language),
    });
  }
  await resolveReferences(h.q, h.root);
}

describe('getAffected on real extractor + resolver output', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness();
    await indexFiles(h, {
      'lib/a.ts': 'export function a(): void {}\n',
      'lib/b.ts':
        "import { a } from './a';\nexport function b(): void {\n  a();\n}\n",
      'lib/b.spec.ts':
        "import { b } from './b';\nexport function t(): void {\n  b();\n}\n",
      'lib/c.ts':
        "import { b } from './b';\nexport function c(): void {\n  b();\n}\n",
      'lib/lonely.ts': 'export function lonely(): void {}\n',
    });
  });
  afterEach(() => h.close());

  it('returns changed file first, then impacted files, and graph-linked tests', () => {
    const r = getAffected(h.q, ['lib/a.ts']);
    expect(r.files).toEqual(['lib/a.ts', 'lib/b.ts', 'lib/c.ts']);
    expect(r.tests).toContain('lib/b.spec.ts');
    expect(r.unknown).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('depth 1 excludes the second hop', () => {
    const r = getAffected(h.q, ['lib/a.ts'], { depth: 1 });
    expect(r.files).toEqual(['lib/a.ts', 'lib/b.ts']);
    expect(r.tests).not.toContain('lib/b.spec.ts');
  });

  it('includeTests false drops tests', () => {
    expect(
      getAffected(h.q, ['lib/a.ts'], { includeTests: false }).tests,
    ).toEqual([]);
  });

  it('keeps a file without dependants as the only result', () => {
    const r = getAffected(h.q, ['lib/lonely.ts']);
    expect(r).toEqual({
      files: ['lib/lonely.ts'],
      tests: [],
      unknown: [],
      truncated: false,
    });
  });

  it('puts unindexed paths in unknown, in order and deduped', () => {
    const r = getAffected(h.q, ['nope.ts', 'lib/a.ts', 'nope.ts', 'x/y.ts']);
    expect(r.unknown).toEqual(['nope.ts', 'x/y.ts']);
    expect(r.files[0]).toBe('lib/a.ts');
  });

  it('empty input gives an empty result', () => {
    expect(getAffected(h.q, [])).toEqual({
      files: [],
      tests: [],
      unknown: [],
      truncated: false,
    });
  });

  it('sends absolute, parent-escaping and NUL paths to unknown', () => {
    const bad = [
      '/etc/passwd',
      '../x.ts',
      'lib/../../x.ts',
      'a\0b.ts',
      'C:\\x.ts',
    ];
    const r = getAffected(h.q, bad);
    expect(r.unknown).toEqual(bad);
    expect(r.files).toEqual([]);
    expect(r.tests).toEqual([]);
  });

  it('normalises backslashes and collapses duplicates', () => {
    const r = getAffected(h.q, ['lib\\a.ts', 'lib/a.ts', './lib/a.ts']);
    expect(r.files).toEqual(['lib/a.ts', 'lib/b.ts', 'lib/c.ts']);
    expect(r.unknown).toEqual([]);
  });

  it('lists a changed test file under tests, not files', () => {
    const r = getAffected(h.q, ['lib/b.spec.ts']);
    expect(r.tests).toEqual(['lib/b.spec.ts']);
    expect(r.files).not.toContain('lib/b.spec.ts');
  });

  it('truncates files to limit and flags it', () => {
    const r = getAffected(h.q, ['lib/a.ts'], { limit: 2 });
    expect(r.files).toEqual(['lib/a.ts', 'lib/b.ts']);
    expect(r.truncated).toBe(true);
  });
});

describe('getAffected sibling tests by convention', () => {
  let h: Harness;
  afterEach(() => h.close());

  const cases: {
    name: string;
    changed: string;
    src: string;
    tests: string[];
    other?: Record<string, string>;
  }[] = [
    {
      name: 'typescript',
      changed: 'src/foo.ts',
      src: 'export const foo = 1;\n',
      tests: [
        'src/foo.spec.ts',
        'src/foo.test.ts',
        'src/__tests__/foo.test.ts',
      ],
    },
    {
      name: 'go',
      changed: 'pkg/foo.go',
      src: 'package pkg\nfunc Foo() {}\n',
      tests: ['pkg/foo_test.go'],
    },
    {
      name: 'python',
      changed: 'app/foo.py',
      src: 'def foo():\n    pass\n',
      tests: ['app/test_foo.py', 'app/foo_test.py', 'app/tests/test_foo.py'],
    },
    {
      name: 'java mirrored',
      changed: 'src/main/java/p/Foo.java',
      src: 'package p;\npublic class Foo {}\n',
      tests: ['src/test/java/p/FooTest.java'],
    },
    {
      name: 'java adjacent',
      changed: 'p/Foo.java',
      src: 'package p;\npublic class Foo {}\n',
      tests: ['p/FooTest.java'],
    },
    {
      name: 'dart',
      changed: 'lib/foo.dart',
      src: 'void foo() {}\n',
      tests: ['test/foo_test.dart'],
    },
    {
      name: 'dart monorepo package',
      changed: 'pkg/lib/foo.dart',
      src: 'void foo() {}\n',
      tests: ['pkg/test/foo_test.dart'],
    },
    {
      name: 'dart adjacent',
      changed: 'lib/foo.dart',
      src: 'void foo() {}\n',
      tests: ['lib/foo_test.dart'],
    },
  ];

  for (const c of cases) {
    it(`finds unlinked ${c.name} tests that exist in the index`, async () => {
      h = createHarness();
      const files: Record<string, string> = { [c.changed]: c.src };
      for (const t of c.tests) files[t] = c.src.replace(/foo|Foo/g, 'x$&');
      await indexFiles(h, files);
      const r = getAffected(h.q, [c.changed]);
      expect(r.tests.sort()).toEqual([...c.tests].sort());
      expect(r.files).toEqual([c.changed]);
    });
  }

  it('ignores conventional siblings that are not indexed', async () => {
    h = createHarness();
    await indexFiles(h, { 'src/foo.ts': 'export const foo = 1;\n' });
    expect(getAffected(h.q, ['src/foo.ts']).tests).toEqual([]);
  });
});

describe('getAffected truncation and edge cases', () => {
  let t: SeededDb;
  beforeEach(() => {
    t = openTempDb();
  });
  afterEach(() => t.close());

  it('flags truncated when the early stop skips dependents', () => {
    seedGraph(
      t.q,
      [
        mkNode('x', { filePath: 'src/x.ts' }),
        mkNode('y', { filePath: 'src/y.ts' }),
        mkNode('z', { filePath: 'src/z.ts' }),
      ],
      [mkEdge('y', 'x')],
    );
    const r = getAffected(t.q, ['src/x.ts', 'src/y.ts', 'src/z.ts'], {
      limit: 1,
    });
    expect(r.truncated).toBe(true);
    expect(r.files).toHaveLength(1);
  });

  it('flags truncated when a hub impact exceeds the per-file node cap', () => {
    const nodes = [mkNode('hub', { filePath: 'src/hub.ts' })];
    const edges = [];
    for (let i = 0; i < 350; i++) {
      nodes.push(mkNode(`c${i}`, { filePath: `src/c${i}.ts` }));
      edges.push(mkEdge(`c${i}`, 'hub'));
    }
    seedGraph(t.q, nodes, edges);
    const r = getAffected(t.q, ['src/hub.ts'], { limit: 100_000 });
    expect(r.truncated).toBe(true);
    expect(r.files.length).toBeLessThan(352);
  });

  it('treats a deleted file still in the index as known', () => {
    t.q.upsertFile({
      path: 'src/gone.ts',
      contentHash: 'h',
      language: 'typescript',
      size: 0,
      modifiedAt: 1,
      indexedAt: 1,
      nodeCount: 0,
      generated: false,
      isTest: false,
    });
    const r = getAffected(t.q, ['src/gone.ts']);
    expect(r.unknown).toEqual([]);
    expect(r.files).toEqual(['src/gone.ts']);
  });
});

describe('getAffected performance', () => {
  let t: SeededDb;
  beforeEach(() => {
    t = openTempDb();
  });
  afterEach(() => t.close());

  it('handles 200 changed files on a 50k-node graph', () => {
    const N = 50_000;
    const FILES = 500;
    const nodes: GraphNode[] = [];
    for (let f = 0; f < FILES; f++)
      nodes.push(
        mkNode(`file${f}`, {
          kind: 'file',
          filePath: `src/f${f}.ts`,
          name: `f${f}.ts`,
        }),
      );
    for (let i = 0; i < N; i++)
      nodes.push(mkNode(`n${i}`, { filePath: `src/f${i % FILES}.ts` }));
    const edges = [];
    for (let i = 1; i < N; i++) edges.push(mkEdge(`n${i}`, `n${i - 1}`));
    seedGraph(t.q, nodes, edges);

    const changed = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`);
    const r = bestOf(() => getAffected(t.q, changed, { limit: 100_000 }));
    expect(r.ms).toBeLessThan(2000);
    expect(r.value.truncated).toBe(false);
    expect(r.value.files).toHaveLength(202);
    expect(r.value.unknown).toEqual([]);
  }, 60_000);
});
