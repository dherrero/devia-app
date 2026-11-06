import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  GraphEdge,
  GraphNode,
} from '../../../../../shared/domain/code-graph';
import { openGraphDb, type GraphDb } from './connection';
import { GraphQueries, type FileRow } from './queries';

function node(
  id: string,
  name: string,
  filePath: string,
  extra: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 3,
    isExported: true,
    ...extra,
  };
}

function fileRow(p: string): FileRow {
  return {
    path: p,
    contentHash: 'h',
    language: 'typescript',
    size: 10,
    modifiedAt: 1,
    indexedAt: 2,
    nodeCount: 0,
    generated: false,
    isTest: false,
  };
}

describe('GraphQueries', () => {
  let dir: string;
  let db: GraphDb;
  let q: GraphQueries;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-q-'));
    db = openGraphDb(path.join(dir, 'graph.db'));
    q = new GraphQueries(db);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(): void {
    q.upsertFile(fileRow('a.ts'));
    q.upsertFile(fileRow('b.ts'));
    q.insertNodes([
      node('a', 'greet', 'a.ts', {
        signature: 'greet(): void',
        docstring: 'says hi',
      }),
      node('b', 'helper', 'a.ts'),
      node('c', 'other', 'b.ts', { isTest: true }),
    ]);
    q.insertEdges([
      { source: 'a', target: 'b', kind: 'calls', line: 2 },
      { source: 'c', target: 'a', kind: 'calls', provenance: 'heuristic' },
    ]);
  }

  it('round-trips nodes and edges', () => {
    seed();
    expect(q.nodeById('a')).toEqual(
      node('a', 'greet', 'a.ts', {
        signature: 'greet(): void',
        docstring: 'says hi',
      }),
    );
    expect(q.nodeById('c')?.isTest).toBe(true);
    expect(q.nodeById('zzz')).toBeUndefined();
    expect(q.nodesByName('helper', 10).map((n) => n.id)).toEqual(['b']);
    expect(
      q
        .nodesInFile('a.ts')
        .map((n) => n.id)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(q.edgesFrom('a')).toEqual<GraphEdge[]>([
      { source: 'a', target: 'b', kind: 'calls', line: 2 },
    ]);
    expect(q.edgesTo('a')).toEqual<GraphEdge[]>([
      { source: 'c', target: 'a', kind: 'calls', provenance: 'heuristic' },
    ]);
    expect(q.edgesFrom('a', ['imports'])).toEqual([]);
    expect(q.edgesTo('b', ['calls', 'imports'])).toHaveLength(1);
    expect(q.counts()).toEqual({ nodes: 3, edges: 2, files: 2 });
  });

  it('keeps one row when the same edge is inserted twice, including without line', () => {
    seed();
    q.insertEdges([
      { source: 'a', target: 'b', kind: 'calls', line: 2 },
      { source: 'b', target: 'c', kind: 'references' },
      { source: 'b', target: 'c', kind: 'references' },
    ]);
    expect(q.counts().edges).toBe(3);
  });

  it('deleteFile removes nodes, cascades edges and unresolved refs', () => {
    seed();
    q.insertUnresolved([
      {
        fromNodeId: 'a',
        referenceName: 'x',
        referenceKind: 'calls',
        line: 1,
        col: 0,
        filePath: 'a.ts',
        language: 'typescript',
        status: 'pending',
        nameTail: '',
      },
    ]);
    q.deleteFile('a.ts');
    expect(q.nodesInFile('a.ts')).toEqual([]);
    expect(q.edgesTo('a')).toEqual([]);
    expect(q.edgesFrom('c')).toEqual([]);
    expect(q.unresolvedByStatus('pending')).toEqual([]);
    expect(q.counts()).toEqual({ nodes: 1, edges: 0, files: 1 });
  });

  it('finds nodes through FTS5 and keeps it in sync on delete', () => {
    seed();
    const hit = (term: string): unknown[] =>
      db.prepare('SELECT id FROM nodes_fts WHERE nodes_fts MATCH ?').all(term);
    expect(hit('greet')).toEqual([{ id: 'a' }]);
    q.deleteFile('a.ts');
    expect(hit('greet')).toEqual([]);
  });

  it('round-trips unresolved refs with metadata and manages their lifecycle', () => {
    seed();
    q.insertUnresolved([
      {
        fromNodeId: 'a',
        referenceName: 'util.greet',
        referenceKind: 'imports',
        line: 4,
        col: 2,
        filePath: 'a.ts',
        language: 'typescript',
        status: 'pending',
        nameTail: '',
        metadata: { binding: 'util', star: true },
      },
      {
        fromNodeId: 'b',
        referenceName: 'plain',
        referenceKind: 'calls',
        line: 5,
        col: 0,
        filePath: 'a.ts',
        language: 'typescript',
        status: 'pending',
        nameTail: '',
      },
    ]);
    const pending = q.unresolvedByStatus('pending');
    expect(pending).toHaveLength(2);
    const withMeta = pending.find((r) => r.referenceName === 'util.greet');
    expect(withMeta?.metadata).toEqual({ binding: 'util', star: true });
    expect(withMeta?.id).toBeTypeOf('number');
    expect(
      'metadata' in (pending.find((r) => r.referenceName === 'plain') ?? {}),
    ).toBe(false);
    expect(q.unresolvedByStatus('pending', 1)).toHaveLength(1);

    q.markUnresolved(withMeta?.id ?? -1, 'failed', 'greet');
    const failed = q.unresolvedByStatus('failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.nameTail).toBe('greet');
    expect(failed[0]?.metadata).toEqual({ binding: 'util', star: true });

    q.deleteUnresolved(failed[0]?.id ?? -1);
    expect(q.unresolvedByStatus('failed')).toEqual([]);
    expect(q.unresolvedByStatus('pending')).toHaveLength(1);
  });

  it('upserts files, stores meta, and rolls back failed transactions', () => {
    q.upsertFile({ ...fileRow('a.ts'), errors: ['boom'], isTest: true });
    q.upsertFile({ ...fileRow('a.ts'), size: 99 });
    expect(q.counts().files).toBe(1);
    expect(db.prepare('SELECT size, is_test, errors FROM files').get()).toEqual(
      {
        size: 99,
        is_test: 0,
        errors: null,
      },
    );

    expect(q.getMeta('k')).toBeUndefined();
    q.setMeta('k', 'v1');
    q.setMeta('k', 'v2');
    expect(q.getMeta('k')).toBe('v2');

    expect(() =>
      q.transaction(() => {
        q.setMeta('t', '1');
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(q.getMeta('t')).toBeUndefined();
    expect(q.transaction(() => 5)).toBe(5);
  });
});
