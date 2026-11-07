import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GraphNode } from '../../../../../shared/domain/code-graph';
import { createHarness, type Harness } from '../resolution/test-support';
import { resolveReferences } from '../resolution/resolver';
import { findPath, getCallees, getCallers, getImpact } from './traversal';
import {
  bestOf,
  mkEdge,
  mkNode,
  openTempDb,
  seedGraph,
  type SeededDb,
} from './test-graph';

function impactOf(
  ...args: Parameters<typeof getImpact>
): NonNullable<ReturnType<typeof getImpact>> {
  const r = getImpact(...args);
  if (!r) throw new Error('impact root not found');
  return r;
}

const names = (ns: { node: GraphNode }[]): string[] =>
  ns.map((n) => n.node.name).sort();

describe('traversal on real extractor + resolver output', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness();
    await h.addFiles({
      'src/a.ts':
        "import { b } from './b';\nexport function a(): void {\n  b();\n}\n",
      'src/b.ts':
        "import { c } from './c';\nexport function b(): void {\n  c();\n}\n",
      'src/c.ts': 'export function c(): void {}\n',
      'src/d.ts':
        "import { b } from './b';\nexport function d(): void {\n  b();\n}\n",
      'src/ef.ts':
        'export function e(): void {\n  f();\n}\nexport function f(): void {\n  e();\n}\n',
    });
    await resolveReferences(h.q, h.root);
  });
  afterEach(() => h.close());

  it('getCallers at depth 1 and 2 with depth annotation', () => {
    const b = h.sym('src/b.ts', 'b');
    const c = h.sym('src/c.ts', 'c');
    const d1 = getCallers(h.q, b.id);
    expect(names(d1)).toEqual(['a', 'd']);
    expect(d1.every((r) => r.depth === 1 && r.edge.kind === 'calls')).toBe(
      true,
    );
    const d2 = getCallers(h.q, c.id, { depth: 2 });
    expect(d2.map((r) => `${r.node.name}:${r.depth}`)).toEqual([
      'b:1',
      'a:2',
      'd:2',
    ]);
    expect(getCallers(h.q, c.id)).toHaveLength(1);
  });

  it('getCallees at depth 1 and 2', () => {
    const a = h.sym('src/a.ts', 'a');
    expect(names(getCallees(h.q, a.id))).toEqual(['b']);
    expect(names(getCallees(h.q, a.id, { depth: 2 }))).toEqual(['b', 'c']);
  });

  it('getImpact returns unique files, root file first, correct depths', () => {
    const c = h.sym('src/c.ts', 'c');
    const r = impactOf(h.q, c.id, { depth: 2 });
    expect(r.root.id).toBe(c.id);
    const fn = (d: number): string[] =>
      (r.byDepth.find((x) => x.depth === d)?.nodes ?? [])
        .filter((n) => n.kind === 'function')
        .map((n) => n.name)
        .sort();
    expect(fn(1)).toEqual(['b']);
    expect(fn(2)).toEqual(['a', 'd']);
    expect(r.files[0]).toBe('src/c.ts');
    expect(new Set(r.files).size).toBe(r.files.length);
    expect([...r.files].sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
    ]);
    expect(r.truncated).toBe(false);
  });

  it('getImpact of a file root covers its symbols and importers', () => {
    const r = impactOf(h.q, h.fileId('src/c.ts'), { depth: 3 });
    expect(r.files[0]).toBe('src/c.ts');
    expect(r.files).toContain('src/b.ts');
    expect(r.files).toContain('src/a.ts');
    const all = r.byDepth.flatMap((x) => x.nodes);
    expect(all.some((n) => n.id === h.fileId('src/c.ts'))).toBe(false);
  });

  it('terminates on cycles without repeating nodes', () => {
    const e = h.sym('src/ef.ts', 'e');
    const callers = getCallers(h.q, e.id, { depth: 10 });
    expect(callers.map((r) => r.node.name)).toEqual(['f']);
    const impact = impactOf(h.q, e.id, { depth: 10 });
    const ids = impact.byDepth.flatMap((x) => x.nodes.map((n) => n.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(e.id);
  });

  it('findPath finds shortest path or null', () => {
    const a = h.sym('src/a.ts', 'a');
    const b = h.sym('src/b.ts', 'b');
    const c = h.sym('src/c.ts', 'c');
    expect(findPath(h.q, a.id, c.id)?.map((n) => n.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(findPath(h.q, c.id, a.id)).toBeNull();
    expect(findPath(h.q, a.id, c.id, { maxDepth: 1 })).toBeNull();
    expect(findPath(h.q, b.id, b.id)?.map((n) => n.name)).toEqual(['b']);
    expect(findPath(h.q, a.id, 'nope')).toBeNull();
  });
});

describe('traversal on hand-seeded graphs', () => {
  let t: SeededDb;
  beforeEach(() => {
    t = openTempDb();
  });
  afterEach(() => t.close());

  it('getImpact returns undefined for unknown ids and vanished file roots', () => {
    seedGraph(t.q, [mkNode('x')], []);
    expect(getImpact(t.q, 'nope')).toBeUndefined();
    expect(getImpact(t.q, 'file:gone')).toBeUndefined();
    expect(getImpact(t.q, 'x')).toBeDefined();
  });

  it('limit cuts the traversal and flags truncated', () => {
    const nodes = [mkNode('root', { isExported: false })];
    const edges = [];
    for (let i = 0; i < 10; i++) {
      nodes.push(mkNode(`n${i}`));
      edges.push(mkEdge(`n${i}`, 'root'));
    }
    seedGraph(t.q, nodes, edges);
    const r = impactOf(t.q, 'root', { limit: 4 });
    expect(r.truncated).toBe(true);
    expect(r.byDepth.flatMap((x) => x.nodes)).toHaveLength(4);
    expect(impactOf(t.q, 'root', { limit: 10 }).truncated).toBe(false);
    expect(getCallers(t.q, 'root', { limit: 3 })).toHaveLength(3);
  });

  it('impact follows the documented kinds and ignores contains/exports/returns', () => {
    seedGraph(
      t.q,
      [
        mkNode('t'),
        mkNode('k1'),
        mkNode('k2'),
        mkNode('k3'),
        mkNode('k4'),
        mkNode('k5'),
        mkNode('k6'),
        mkNode('k7'),
        mkNode('k8'),
        mkNode('no1'),
        mkNode('no2'),
        mkNode('no3'),
      ],
      [
        mkEdge('k1', 't', 'calls'),
        mkEdge('k2', 't', 'references'),
        mkEdge('k3', 't', 'extends'),
        mkEdge('k4', 't', 'implements'),
        mkEdge('k5', 't', 'instantiates'),
        mkEdge('k6', 't', 'type_of'),
        mkEdge('k7', 't', 'overrides'),
        mkEdge('k8', 't', 'decorates'),
        mkEdge('no1', 't', 'contains'),
        mkEdge('no2', 't', 'exports'),
        mkEdge('no3', 't', 'returns'),
      ],
    );
    const ids = impactOf(t.q, 't')
      .byDepth.flatMap((x) => x.nodes.map((n) => n.id))
      .sort();
    expect(ids).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8']);
  });

  it('importing file nodes of an exported root file are impacted', () => {
    seedGraph(
      t.q,
      [
        mkNode('lib', { isExported: true, filePath: 'src/lib.ts' }),
        mkNode('F:lib', { kind: 'file', filePath: 'src/lib.ts' }),
        mkNode('F:app', { kind: 'file', filePath: 'src/app.ts' }),
        mkNode('appFn', { filePath: 'src/app.ts' }),
        mkNode('F:main', { kind: 'file', filePath: 'src/main.ts' }),
      ],
      [
        mkEdge('F:app', 'F:lib', 'imports'),
        mkEdge('F:main', 'F:app', 'imports'),
        mkEdge('F:app', 'appFn', 'contains'),
      ],
    );
    const r = impactOf(t.q, 'lib');
    expect(r.byDepth.map((x) => [x.depth, x.nodes.map((n) => n.id)])).toEqual([
      [1, ['F:app']],
      [2, ['F:main']],
    ]);
    expect(r.files).toEqual(['src/lib.ts', 'src/app.ts', 'src/main.ts']);
    const fr = impactOf(t.q, 'F:lib');
    expect(fr.files).toEqual(['src/lib.ts', 'src/app.ts', 'src/main.ts']);
  });

  it('includeInheritance follows dispatch: callers of bases, overriders of callees', () => {
    seedGraph(
      t.q,
      [
        mkNode('base', { kind: 'method' }),
        mkNode('sub', { kind: 'method' }),
        mkNode('sub2', { kind: 'method' }),
        mkNode('user'),
        mkNode('driver'),
      ],
      [
        mkEdge('sub', 'base', 'overrides'),
        mkEdge('sub2', 'sub', 'implements'),
        mkEdge('user', 'base', 'calls'),
        mkEdge('driver', 'base', 'calls'),
      ],
    );
    expect(getCallers(t.q, 'sub')).toEqual([]);
    expect(getCallees(t.q, 'user').map((r) => r.node.id)).toEqual(['base']);

    const callers = getCallers(t.q, 'sub2', { includeInheritance: true });
    expect(callers.map((r) => r.node.id).sort()).toEqual(['driver', 'user']);
    expect(callers.every((r) => r.via === 'dispatch' && r.depth === 1)).toBe(
      true,
    );

    const callees = getCallees(t.q, 'user', { includeInheritance: true });
    expect(callees.map((r) => [r.node.id, r.via])).toEqual([
      ['base', undefined],
      ['sub', 'dispatch'],
      ['sub2', 'dispatch'],
    ]);
    expect('via' in (callees[0] ?? {})).toBe(false);
    expect(getCallees(t.q, 'base', { includeInheritance: true })).toEqual([]);
  });

  it('constructor callers include instantiates of the class', () => {
    seedGraph(
      t.q,
      [
        mkNode('cls', { kind: 'class', name: 'Foo' }),
        mkNode('ctor', { kind: 'method', name: 'constructor' }),
        mkNode('m', { kind: 'method', name: 'run' }),
        mkNode('maker'),
      ],
      [
        mkEdge('cls', 'ctor', 'contains'),
        mkEdge('cls', 'm', 'contains'),
        mkEdge('maker', 'cls', 'instantiates'),
      ],
    );
    expect(getCallers(t.q, 'ctor').map((r) => r.node.id)).toEqual(['maker']);
    expect(getCallers(t.q, 'm')).toEqual([]);
    expect(getCallees(t.q, 'maker').map((r) => r.node.id)).toEqual(['cls']);
  });

  it('findPath is shortest with deterministic tie-break and ignores contains', () => {
    seedGraph(
      t.q,
      [mkNode('s'), mkNode('m1'), mkNode('m2'), mkNode('z'), mkNode('long')],
      [
        mkEdge('s', 'm2', 'calls'),
        mkEdge('s', 'm1', 'references'),
        mkEdge('m1', 'z', 'calls'),
        mkEdge('m2', 'z', 'calls'),
        mkEdge('s', 'long', 'contains'),
        mkEdge('long', 'z', 'calls'),
      ],
    );
    expect(findPath(t.q, 's', 'z')?.map((n) => n.id)).toEqual(['s', 'm1', 'z']);
  });
});

describe('traversal performance', () => {
  let t: SeededDb;
  beforeEach(() => {
    t = openTempDb();
  });
  afterEach(() => t.close());

  it('handles 50k nodes / 150k edges within bounds', () => {
    const N = 50_000;
    const nodes: GraphNode[] = [mkNode('iso')];
    for (let i = 0; i < N; i++)
      nodes.push(mkNode(`n${i}`, { filePath: `src/f${i % 500}.ts` }));
    const edges = [];
    let seed = 1;
    const rnd = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let i = 1; i < N; i++) edges.push(mkEdge(`n${i}`, `n${i - 1}`));
    for (let i = 0; i < 100_000; i++)
      edges.push(mkEdge(`n${rnd() % N}`, `n${rnd() % N}`, 'references'));
    seedGraph(t.q, nodes, edges);
    expect(t.q.counts().edges).toBeGreaterThan(140_000);

    const r = bestOf(() => impactOf(t.q, 'n0', { depth: 3, limit: 200 }));
    expect(r.ms).toBeLessThan(500);
    expect(r.value.byDepth.flatMap((x) => x.nodes).length).toBeLessThanOrEqual(
      200,
    );

    const p = bestOf(() => findPath(t.q, `n${N - 1}`, 'n0', { maxDepth: 40 }));
    expect(p.ms).toBeLessThan(3000);
    expect(p.value).not.toBeNull();

    const none = bestOf(() =>
      findPath(t.q, `n${N - 1}`, 'iso', { maxDepth: 40 }),
    );
    expect(none.ms).toBeLessThan(3000);
    expect(none.value).toBeNull();
  }, 60_000);
});

describe('cross-file impact per language', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(() => h.close());

  it('Go: an exported (capitalised) function reaches its importer', async () => {
    await h.addFiles({
      'go.mod': 'module example.com/app\n\ngo 1.21\n',
      'util/util.go': 'package util\n\nfunc Helper() int {\n\treturn 1\n}\n',
      'main.go':
        'package main\n\nimport "example.com/app/util"\n\nfunc main() {\n\tutil.Helper()\n}\n',
    });
    await resolveReferences(h.q, h.root);
    const helper = h.sym('util/util.go', 'Helper');
    expect(helper.isExported).toBe(true);
    const r = impactOf(h.q, helper.id);
    expect(r.files).toContain('main.go');
    expect(
      r.byDepth
        .flatMap((x) => x.nodes)
        .some((n) => n.kind === 'file' && n.filePath === 'main.go'),
    ).toBe(true);
    expect(r.byDepth.flatMap((x) => x.nodes.map((n) => n.name))).toContain(
      'main',
    );
  });

  it('Python: a public module-level name reaches its importer', async () => {
    await h.addFiles({
      'pkg/__init__.py': '',
      'pkg/lib.py': 'def helper():\n    return 1\n',
      'pkg/app.py':
        'from pkg.lib import helper\n\n\ndef run():\n    return helper()\n',
    });
    await resolveReferences(h.q, h.root);
    const helper = h.sym('pkg/lib.py', 'helper');
    expect(helper.isExported).toBe(true);
    const r = impactOf(h.q, helper.id);
    expect(r.files).toContain('pkg/app.py');
    expect(
      r.byDepth
        .flatMap((x) => x.nodes)
        .some((n) => n.kind === 'file' && n.filePath === 'pkg/app.py'),
    ).toBe(true);
    expect(r.byDepth.flatMap((x) => x.nodes.map((n) => n.name))).toContain(
      'run',
    );
  });
});
