import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveReferences } from '../resolution/resolver';
import { createHarness, type Harness } from '../resolution/test-support';
import {
  computeCommunities,
  findHubs,
  persistCommunities,
  readCommunities,
} from './communities';
import {
  mkEdge,
  bestOf,
  mkNode,
  openTempDb,
  seedGraph,
  type SeededDb,
} from './test-graph';

const fileNode = (id: string) => mkNode(id, { kind: 'file' });

function clique(ids: string[]) {
  const edges = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      edges.push(mkEdge(ids[i] as string, ids[j] as string, 'imports'));
  return edges;
}

describe('computeCommunities', () => {
  let t: SeededDb;
  beforeEach(() => {
    t = openTempDb();
  });
  afterEach(() => t.close());

  const A = ['a1', 'a2', 'a3', 'a4'];
  const B = ['b1', 'b2', 'b3', 'b4'];
  const seedCliques = (): void =>
    seedGraph(t.q, [...A, ...B].map(fileNode), [
      ...clique(A),
      ...clique(B),
      mkEdge('a1', 'b1', 'imports'),
    ]);
  const path = (id: string): string => `src/${id}.ts`;

  it('splits two cliques joined by one edge into 2 communities', () => {
    seedCliques();
    const { assignments, count } = computeCommunities(t.q);
    expect(count).toBe(2);
    expect(assignments.size).toBe(8);
    const ca = new Set(A.map((i) => assignments.get(path(i))));
    const cb = new Set(B.map((i) => assignments.get(path(i))));
    expect(ca.size).toBe(1);
    expect(cb.size).toBe(1);
    expect([...ca][0]).not.toBe([...cb][0]);
  });

  it('is deterministic for the same input and seed', () => {
    seedCliques();
    const one = computeCommunities(t.q, { seed: 7 });
    const two = computeCommunities(t.q, { seed: 7 });
    expect([...one.assignments]).toEqual([...two.assignments]);
    expect(one.count).toBe(two.count);
  });

  it('yields a valid partition for a different seed', () => {
    seedCliques();
    const { assignments, count } = computeCommunities(t.q, { seed: 99 });
    expect(assignments.size).toBe(8);
    const ids = new Set(assignments.values());
    expect(ids.size).toBe(count);
    expect([...ids].sort((x, y) => x - y)).toEqual(
      Array.from({ length: count }, (_, i) => i),
    );
  });

  it('gives every file its own community when there are no edges', () => {
    seedGraph(t.q, ['x', 'y', 'z'].map(fileNode), []);
    const { assignments, count } = computeCommunities(t.q);
    expect(count).toBe(3);
    expect(new Set(assignments.values()).size).toBe(3);
  });

  it('renumbers by descending size then smallest path, stably', () => {
    const small = ['s1', 's2'];
    const big = ['z1', 'z2', 'z3', 'z4'];
    seedGraph(t.q, [...small, ...big].map(fileNode), [
      ...clique(small),
      ...clique(big),
    ]);
    for (const seed of [1, 2, 3]) {
      const { assignments } = computeCommunities(t.q, { seed });
      expect(assignments.get(path('z1'))).toBe(0);
      expect(assignments.get(path('s1'))).toBe(1);
    }
  });

  it('runs end to end on real extractor output', async () => {
    const h: Harness = createHarness();
    try {
      await h.addFiles({
        'src/a.ts':
          "import { b } from './b';\nexport function a(): void {\n  b();\n}\n",
        'src/b.ts': 'export function b(): void {}\n',
        'src/lone.ts': 'export const x = 1;\n',
      });
      await resolveReferences(h.q, h.root);
      const { assignments, count } = computeCommunities(h.q);
      expect(assignments.get('src/a.ts')).toBe(assignments.get('src/b.ts'));
      expect(assignments.get('src/lone.ts')).not.toBe(
        assignments.get('src/a.ts'),
      );
      expect(count).toBe(2);
    } finally {
      h.close();
    }
  });

  it('scales to 20k files and 200k pairs', () => {
    const N = 20000;
    const nodes = Array.from({ length: N }, (_, i) => fileNode(`f${i}`));
    t.q.transaction(() => {
      seedGraph(t.q, nodes, []);
      const edges = [];
      for (let i = 0; i < N; i++)
        for (let k = 1; k <= 10; k++)
          edges.push(mkEdge(`f${i}`, `f${(i * 7 + k * 131) % N}`, 'imports'));
      t.q.insertEdges(edges);
    });
    const run = bestOf(() => computeCommunities(t.q));
    expect(run.ms).toBeLessThan(10_000);
    expect(run.value.assignments.size).toBe(N);
  }, 120_000);
});

describe('findHubs', () => {
  let t: SeededDb;
  beforeEach(() => {
    t = openTempDb();
  });
  afterEach(() => t.close());

  it('ranks the highest weighted degree first and skips file/test/generated nodes', () => {
    seedGraph(
      t.q,
      [
        mkNode('hub'),
        mkNode('m1'),
        mkNode('m2'),
        mkNode('m3'),
        mkNode('leaf'),
        mkNode('tfn', { filePath: 'src/x.test.ts' }),
        mkNode('gfn', { filePath: 'src/gen.ts' }),
        fileNode('fl'),
      ],
      [
        mkEdge('m1', 'hub'),
        mkEdge('m2', 'hub'),
        mkEdge('m3', 'hub'),
        mkEdge('hub', 'leaf'),
        mkEdge('tfn', 'hub'),
        mkEdge('gfn', 'hub'),
        mkEdge('fl', 'hub', 'imports'),
        mkEdge('fl', 'hub', 'contains'),
        mkEdge('fl', 'tfn', 'calls'),
        mkEdge('fl', 'gfn', 'calls'),
        mkEdge('fl', 'fl', 'calls'),
      ],
    );
    for (const [p, flags] of [
      ['src/x.test.ts', { isTest: true, generated: false }],
      ['src/gen.ts', { isTest: false, generated: true }],
    ] as const)
      t.q.upsertFile({
        path: p,
        contentHash: 'h',
        language: 'typescript',
        size: 1,
        modifiedAt: 1,
        indexedAt: 1,
        nodeCount: 0,
        ...flags,
      });
    const hubs = findHubs(t.q);
    expect(hubs[0]?.nodeId).toBe('hub');
    expect(hubs[0]?.degree).toBe(12);
    expect(hubs[0]?.score).toBe(1);
    const ids = hubs.map((h) => h.nodeId);
    expect(ids).not.toContain('fl');
    expect(ids).not.toContain('tfn');
    expect(ids).not.toContain('gfn');
    expect(hubs.every((h) => h.score >= 0 && h.score <= 1)).toBe(true);
    for (let i = 1; i < hubs.length; i++)
      expect((hubs[i - 1] as { degree: number }).degree).toBeGreaterThanOrEqual(
        (hubs[i] as { degree: number }).degree,
      );
  });

  it('honours top and breaks ties by qualifiedName', () => {
    seedGraph(
      t.q,
      [mkNode('b'), mkNode('a'), mkNode('c')],
      [mkEdge('a', 'b'), mkEdge('b', 'c')],
    );
    const hubs = findHubs(t.q, { top: 2 });
    expect(hubs.map((h) => h.nodeId)).toEqual(['b', 'a']);
  });

  it('returns an empty list for an empty graph', () => {
    expect(findHubs(t.q)).toEqual([]);
  });
});

describe('persistCommunities / readCommunities', () => {
  let t: SeededDb;
  beforeEach(() => {
    t = openTempDb();
  });
  afterEach(() => t.close());

  it('round-trips and records the count', () => {
    const m = new Map([
      ['src/a.ts', 0],
      ['src/b.ts', 1],
      ['src/c.ts', 1],
    ]);
    t.q.transaction(() => persistCommunities(t.q, m));
    expect(readCommunities(t.q)).toEqual(m);
    expect(t.q.getMeta('community_count')).toBe('2');
  });

  it('returns an empty map when absent or corrupt', () => {
    expect(readCommunities(t.q).size).toBe(0);
    t.q.setMeta('communities', '{not json');
    expect(readCommunities(t.q).size).toBe(0);
    t.q.setMeta('communities', '[1,2]');
    expect(readCommunities(t.q).size).toBe(0);
    t.q.setMeta('communities', '{"a.ts":"x"}');
    expect(readCommunities(t.q).size).toBe(0);
  });
});
