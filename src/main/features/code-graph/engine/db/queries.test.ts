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

  it('round-trips every optional node field and omits absent ones', () => {
    const full = node('f', 'full', 'a.ts', {
      signature: 's',
      docstring: 'd',
      isTest: true,
      visibility: 'protected',
      isAsync: true,
      isStatic: true,
      isAbstract: true,
      decorators: ['@a', '@b'],
      metadata: { k: 'v', flag: true },
    });
    const bare = node('g', 'bare', 'a.ts');
    q.insertNodes([full, bare]);
    expect(q.nodeById('f')).toEqual(full);
    const read = q.nodeById('g');
    expect(read).toEqual(bare);
    for (const key of [
      'visibility',
      'isAsync',
      'isStatic',
      'isAbstract',
      'decorators',
      'metadata',
    ]) {
      expect(read).not.toHaveProperty(key);
    }
  });

  it('re-inserting a node keeps its edges and refreshes FTS', () => {
    q.insertNodes([node('a', 'oldname', 'a.ts'), node('b', 'target', 'a.ts')]);
    q.insertEdges([{ source: 'a', target: 'b', kind: 'calls', line: 1 }]);
    q.insertNodes([node('a', 'newname', 'a.ts')]);
    expect(q.edgesFrom('a')).toHaveLength(1);
    const hit = (term: string): unknown[] =>
      db.prepare('SELECT id FROM nodes_fts WHERE nodes_fts MATCH ?').all(term);
    expect(hit('newname')).toEqual([{ id: 'a' }]);
    expect(hit('oldname')).toEqual([]);
    expect(q.counts().nodes).toBe(2);
  });

  it('serves the bulk reads reference resolution needs', () => {
    seed();
    q.insertNodes([
      node('d', 'ctor', 'b.ts', {
        kind: 'method',
        metadata: { constructor: true },
        docstring: 'x',
      }),
    ]);
    q.insertEdges([{ source: 'c', target: 'd', kind: 'contains' }]);
    const ref = (
      fromNodeId: string,
      referenceName: string,
      filePath: string,
      status: 'pending' | 'failed',
    ) => ({
      fromNodeId,
      referenceName,
      referenceKind: referenceName.startsWith('./')
        ? ('imports' as const)
        : ('calls' as const),
      line: 1,
      col: 0,
      filePath,
      language: 'typescript' as const,
      status,
      nameTail: referenceName.replace('./', ''),
    });
    q.insertUnresolved([
      ref('a', './m', 'a.ts', 'pending'),
      ref('a', 'x', 'a.ts', 'pending'),
      ref('c', 'y', 'b.ts', 'failed'),
      ref('c', './z', 'b.ts', 'failed'),
    ]);

    expect(q.filePaths().sort()).toEqual(['a.ts', 'b.ts']);
    const summaries = q.nodeSummaries();
    expect(summaries.map((n) => n.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    const d = summaries.find((n) => n.id === 'd');
    expect(d).toEqual({
      id: 'd',
      kind: 'method',
      name: 'ctor',
      qualifiedName: 'b.ts::ctor',
      filePath: 'b.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 3,
      isExported: true,
      metadata: { constructor: true },
    });
    expect(summaries.find((n) => n.id === 'a')).not.toHaveProperty('metadata');
    expect(q.edgesOfKinds(['contains'])).toEqual([
      { source: 'c', target: 'd', kind: 'contains' },
    ]);
    expect(q.edgesOfKinds(['calls', 'contains'])).toHaveLength(3);

    expect(
      q.unresolvedByKinds('pending', ['imports']).map((r) => r.referenceName),
    ).toEqual(['./m']);
    expect(
      q
        .unresolvedByKinds('failed', ['calls', 'imports'])
        .map((r) => r.referenceName),
    ).toEqual(['y', './z']);
    expect(
      q.unresolvedInFiles(['b.ts'], 'failed').map((r) => r.referenceName),
    ).toEqual(['y', './z']);
    expect(q.unresolvedInFiles(['a.ts', 'nope.ts'], 'pending')).toHaveLength(2);
    expect(q.unresolvedInFiles([], 'pending')).toEqual([]);
    expect(
      q.failedByNameTails(['y', 'm', 'z']).map((r) => r.referenceName),
    ).toEqual(['y', './z']);
    const many = Array.from({ length: 2000 }, (_, i) => `t${i}`);
    expect(q.failedByNameTails([...many, 'y'])).toHaveLength(1);
  });
});
