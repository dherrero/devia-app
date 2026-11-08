import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EdgeKind, GraphEdge, GraphNode } from '../../../../../shared/domain/code-graph';
import { mkNode, openTempDb, type SeededDb } from '../graph/test-graph';
import { HUB_EDGE_WEIGHTS } from '../graph/communities';
import { openGraphDb, type GraphDb } from './connection';
import { GraphQueries } from './queries';

const AGG: EdgeKind[] = ['imports', 'calls', 'instantiates', 'extends', 'implements', 'references'];

function file(path: string, extra: Partial<GraphNode> = {}): GraphNode {
  return mkNode(`F:${path}`, {
    kind: 'file',
    name: path.slice(path.lastIndexOf('/') + 1),
    qualifiedName: path,
    filePath: path,
    startLine: 1,
    endLine: 50,
    ...extra,
  });
}

function sym(id: string, path: string, line: number, extra: Partial<GraphNode> = {}): GraphNode {
  return mkNode(id, { filePath: path, startLine: line, endLine: line + 1, ...extra });
}

const e = (source: string, target: string, kind: EdgeKind = 'calls'): GraphEdge => ({ source, target, kind });

/*
 * a/x.ts      : class A { m1, m2 }, function f
 * a/b/y.ts    : function g
 * c/z.py      : function h (python)
 * root.ts     : function r
 * t/t.test.ts : function tt (test file)
 */
const NODES: GraphNode[] = [
  file('a/x.ts'),
  sym('A', 'a/x.ts', 2, { kind: 'class', isExported: true }),
  sym('m1', 'a/x.ts', 3, { kind: 'method' }),
  sym('m2', 'a/x.ts', 4, { kind: 'method' }),
  sym('f', 'a/x.ts', 10, { isExported: true }),
  file('a/b/y.ts'),
  sym('g', 'a/b/y.ts', 2),
  file('c/z.py', { language: 'python' }),
  sym('h', 'c/z.py', 2, { language: 'python' }),
  file('root.ts'),
  sym('r', 'root.ts', 2),
  file('t/t.test.ts', { isTest: true }),
  sym('tt', 't/t.test.ts', 2, { isTest: true }),
];

const EDGES: GraphEdge[] = [
  e('F:a/x.ts', 'A', 'contains'),
  e('A', 'm1', 'contains'),
  e('A', 'm2', 'contains'),
  e('F:a/x.ts', 'f', 'contains'),
  e('F:a/b/y.ts', 'g', 'contains'),
  e('F:c/z.py', 'h', 'contains'),
  e('F:root.ts', 'r', 'contains'),
  e('F:t/t.test.ts', 'tt', 'contains'),
  e('f', 'g'),
  e('m1', 'h'),
  e('g', 'h'),
  e('g', 'g'),
  e('F:root.ts', 'F:a/x.ts', 'imports'),
  e('h', 'A', 'references'),
  e('tt', 'f'),
  e('m1', 'm2'),
  e('f', 'A', 'instantiates'),
  e('m2', 'f', 'type_of'),
];

function seed(db: Pick<SeededDb, 'q'>): void {
  const { q } = db;
  const byFile = new Map<string, GraphNode[]>();
  for (const n of NODES) byFile.set(n.filePath, [...(byFile.get(n.filePath) ?? []), n]);
  for (const [p, nodes] of byFile) {
    const first = nodes[0] as GraphNode;
    q.upsertFile({
      path: p,
      contentHash: 'h',
      language: first.language,
      size: 1,
      modifiedAt: 1,
      indexedAt: 1,
      nodeCount: nodes.length,
      generated: false,
      isTest: p.startsWith('t/'),
    });
  }
  q.upsertFile({
    path: 'a/broken.ts',
    contentHash: 'h',
    language: 'typescript',
    size: 1,
    modifiedAt: 1,
    indexedAt: 1,
    nodeCount: 0,
    generated: false,
    isTest: false,
    errors: ['boom'],
  });
  q.insertNodes(NODES);
  q.insertEdges(EDGES);
}

describe('GraphQueries view queries', () => {
  let db: SeededDb;
  beforeEach(() => {
    db = openTempDb();
    seed(db);
  });
  afterEach(() => db.close());

  describe('viewDirChildren', () => {
    it('lists the root entries, dirs first then files, with counts', () => {
      expect(db.q.viewDirChildren('')).toEqual([
        { path: 'a', isDir: true, fileCount: 2, symbolCount: 5, childCount: 2 },
        { path: 'c', isDir: true, fileCount: 1, symbolCount: 1, childCount: 1 },
        { path: 't', isDir: true, fileCount: 1, symbolCount: 1, childCount: 1 },
        {
          path: 'root.ts',
          isDir: false,
          fileCount: 1,
          symbolCount: 1,
          childCount: 1,
          fileId: 'F:root.ts',
          language: 'typescript',
        },
      ]);
    });

    it('lists a nested directory and skips files without a file node', () => {
      expect(db.q.viewDirChildren('a')).toEqual([
        { path: 'a/b', isDir: true, fileCount: 1, symbolCount: 1, childCount: 1 },
        {
          path: 'a/x.ts',
          isDir: false,
          fileCount: 1,
          symbolCount: 4,
          childCount: 2,
          fileId: 'F:a/x.ts',
          language: 'typescript',
        },
      ]);
    });

    it('flags test files and ignores sibling dirs sharing a name prefix', () => {
      db.q.upsertFile({
        path: 'ab/q.ts',
        contentHash: 'h',
        language: 'typescript',
        size: 1,
        modifiedAt: 1,
        indexedAt: 1,
        nodeCount: 1,
        generated: false,
        isTest: false,
      });
      db.q.insertNodes([file('ab/q.ts')]);
      expect(db.q.viewDirChildren('a').map((r) => r.path)).toEqual(['a/b', 'a/x.ts']);
      expect(db.q.viewDirChildren('t')).toEqual([
        expect.objectContaining({ path: 't/t.test.ts', isTest: true, language: 'typescript' }),
      ]);
    });

    it('returns nothing for an unknown directory', () => {
      expect(db.q.viewDirChildren('nope')).toEqual([]);
    });
  });

  describe('viewTopLevelEdges', () => {
    it('counts real edges between root entries, dirs keyed with a trailing slash', () => {
      const rows = db.q.viewTopLevelEdges(AGG);
      expect(rows).toEqual([
        { source: 'a/', target: 'c/', weight: 2 },
        { source: 'c/', target: 'a/', weight: 1 },
        { source: 'root.ts', target: 'a/', weight: 1 },
        { source: 't/', target: 'a/', weight: 1 },
      ]);
    });
  });

  describe('viewAggregateEdges', () => {
    it('maps both endpoints through rep, counts once per edge and drops self/null pairs', () => {
      const seen: [string, string][] = [];
      const rows = db.q.viewAggregateEdges({
        scope: { dir: 'a' },
        kinds: AGG,
        inScope: () => true,
        rep: (filePath, id) => {
          seen.push([filePath, id]);
          if (filePath.startsWith('a/')) return filePath;
          if (filePath.startsWith('c/')) return 'dir:c';
          return null;
        },
      });
      expect(rows).toEqual([
        { source: 'a/b/y.ts', target: 'dir:c', weight: 1 },
        { source: 'a/x.ts', target: 'a/b/y.ts', weight: 1 },
        { source: 'a/x.ts', target: 'dir:c', weight: 1 },
        { source: 'dir:c', target: 'a/x.ts', weight: 1 },
      ]);
      expect(seen).toContainEqual(['root.ts', 'F:root.ts']);
    });

    it('restricts the scope with inScope without double counting edges inside the scope', () => {
      const rows = db.q.viewAggregateEdges({
        scope: { dir: 'a' },
        kinds: AGG,
        inScope: (p) => p === 'a/b/y.ts',
        rep: (filePath) => filePath,
      });
      expect(rows).toEqual([
        { source: 'a/b/y.ts', target: 'c/z.py', weight: 1 },
        { source: 'a/x.ts', target: 'a/b/y.ts', weight: 1 },
      ]);
    });

    it('scopes to one file', () => {
      const rows = db.q.viewAggregateEdges({
        scope: { file: 'a/x.ts' },
        kinds: AGG,
        inScope: () => true,
        rep: (_p, id) => id,
      });
      expect(rows).toEqual([
        { source: 'F:root.ts', target: 'F:a/x.ts', weight: 1 },
        { source: 'f', target: 'A', weight: 1 },
        { source: 'f', target: 'g', weight: 1 },
        { source: 'h', target: 'A', weight: 1 },
        { source: 'm1', target: 'h', weight: 1 },
        { source: 'm1', target: 'm2', weight: 1 },
        { source: 'tt', target: 'f', weight: 1 },
      ]);
    });
  });

  it('nodeLocations returns kind and file of the known ids only', () => {
    expect(db.q.nodeLocations(['m1', 'F:c/z.py', 'ghost'])).toEqual([
      { id: 'F:c/z.py', kind: 'file', filePath: 'c/z.py' },
      { id: 'm1', kind: 'method', filePath: 'a/x.ts' },
    ]);
  });

  it('containsParents maps every node of the files to its container', () => {
    expect(Object.fromEntries(db.q.containsParents(['a/x.ts']))).toEqual({
      A: 'F:a/x.ts',
      m1: 'A',
      m2: 'A',
      f: 'F:a/x.ts',
    });
  });

  it('containsChildren pages the direct children in source order and counts them', () => {
    expect(db.q.containsChildren('F:a/x.ts', 0, 10).map((n) => n.id)).toEqual(['A', 'f']);
    expect(db.q.containsChildren('F:a/x.ts', 1, 10).map((n) => n.id)).toEqual(['f']);
    expect(db.q.containsChildren('A', 0, 1).map((n) => n.id)).toEqual(['m1']);
    expect(Object.fromEntries(db.q.containsChildCounts(['F:a/x.ts', 'A', 'm1']))).toEqual({
      'F:a/x.ts': 2,
      A: 2,
    });
  });

  it('fileNodeIds maps paths to their file node', () => {
    expect(Object.fromEntries(db.q.fileNodeIds(['a/x.ts', 'a/broken.ts', 'zzz']))).toEqual({
      'a/x.ts': 'F:a/x.ts',
    });
  });

  it('dirSummary counts files, symbols and languages of a subtree', () => {
    expect(db.q.dirSummary('a')).toEqual({ fileCount: 2, symbolCount: 5, languages: { typescript: 2 } });
    expect(db.q.dirSummary('c')).toEqual({ fileCount: 1, symbolCount: 1, languages: { python: 1 } });
    expect(db.q.dirSummary('nope')).toEqual({ fileCount: 0, symbolCount: 0, languages: {} });
  });

  it('topHubsUnder ranks by weighted degree inside the dir, never files or tests', () => {
    expect(db.q.topHubsUnder('a', HUB_EDGE_WEIGHTS, 5).map((n) => n.id)).toEqual(['f', 'g', 'm1', 'A', 'm2']);
    expect(db.q.topHubsUnder('t', HUB_EDGE_WEIGHTS, 5)).toEqual([]);
    expect(db.q.topHubsUnder('a', HUB_EDGE_WEIGHTS, 1).map((n) => n.id)).toEqual(['f']);
  });

  it('lists the files a file imports and the files importing it', () => {
    expect(db.q.importingFilePaths('a/x.ts')).toEqual(['root.ts']);
    expect(db.q.importedFilePaths('root.ts')).toEqual(['a/x.ts']);
    expect(db.q.importedFilePaths('a/x.ts')).toEqual([]);
  });

  it('fileSymbolCount excludes the file node', () => {
    expect(db.q.fileSymbolCount('a/x.ts')).toBe(4);
    expect(db.q.fileSymbolCount('nope')).toBe(0);
  });

  it('searchFiles matches path substrings case-insensitively, shortest first', () => {
    expect(db.q.searchFiles('X.T', 10).map((n) => n.id)).toEqual(['F:a/x.ts']);
    expect(db.q.searchFiles('.ts', 2).map((n) => n.id)).toEqual(['F:a/x.ts', 'F:root.ts']);
    expect(db.q.searchFiles('%', 10)).toEqual([]);
  });
});

describe('GraphQueries view aggregations and the id/file_path index', () => {
  let dir: string;
  let raw: GraphDb;
  let sqls: string[];
  let q: GraphQueries;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-view-idx-'));
    raw = openGraphDb(path.join(dir, 'graph.db'));
    sqls = [];
    const prepare = raw.prepare.bind(raw);
    raw.prepare = ((sql: string) => {
      sqls.push(sql);
      return prepare(sql);
    }) as typeof raw.prepare;
    q = new GraphQueries(raw);
    seed({ q });
  });
  afterEach(() => {
    raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const aggregate = (): unknown =>
    q.viewAggregateEdges({ scope: { dir: 'a' }, kinds: AGG, inScope: () => true, rep: (p) => p });

  const plans = (): string[] =>
    sqls
      .filter((s) => s.includes('cg_view_rep') || s.includes("instr(ns.file_path || '/', '/')"))
      .map((s) =>
        (raw.prepare(`EXPLAIN QUERY PLAN ${s}`).all(...Array<string>(countParams(s)).fill('')) as { detail: string }[])
          .map((r) => r.detail)
          .join('\n'),
      );

  it('looks the edge endpoints up through the covering index', () => {
    aggregate();
    q.viewTopLevelEdges(AGG);
    const got = plans();
    expect(got).toHaveLength(2);
    for (const plan of got) {
      expect(plan).toMatch(/COVERING INDEX idx_nodes_id_file/);
      expect(plan).not.toMatch(/sqlite_autoindex_nodes_1/);
    }
    expect(got[1]?.split('\n')[0]).toMatch(/^SCAN e\b/);
  });

  it('answers the same on a graph created before the index existed', () => {
    const before = { agg: aggregate(), top: q.viewTopLevelEdges(AGG) };
    raw.exec('DROP INDEX idx_nodes_id_file');
    const fresh = new GraphQueries(raw);
    q = fresh;
    expect({ agg: aggregate(), top: q.viewTopLevelEdges(AGG) }).toEqual(before);
  });
});

function countParams(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}
