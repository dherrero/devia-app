import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GraphNode } from '../../../../../shared/domain/code-graph';
import { openGraphDb, type GraphDb } from '../db/connection';
import { GraphQueries, type FileRow } from '../db/queries';
import { createParser, grammarVariantForPath, languageForPath } from '../extraction/grammars';
import { extractorFor } from '../extraction/registry';
import { searchSymbols } from './search';

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

function fileRow(p: string, extra: Partial<FileRow> = {}): FileRow {
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
    ...extra,
  };
}

describe('searchSymbols', () => {
  let dir: string;
  let db: GraphDb;
  let q: GraphQueries;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-search-'));
    db = openGraphDb(path.join(dir, 'graph.db'));
    q = new GraphQueries(db);
    q.upsertFile(fileRow('src/user.ts'));
    q.upsertFile(fileRow('src/user.test.ts', { isTest: true }));
    q.upsertFile(fileRow('src/gen.ts', { generated: true }));
    q.insertNodes([
      node('1', 'getUserById', 'src/user.ts'),
      node('2', 'getUser', 'src/user.ts'),
      node('3', 'UserService', 'src/user.ts', { kind: 'class' }),
      node('4', 'getUserMock', 'src/user.test.ts'),
      node('5', 'GeneratedUserClient', 'src/gen.ts', { kind: 'class' }),
      node('6', 'save_100%', 'src/user.ts'),
      node('7', 'save1000', 'src/user.ts'),
      node('8', 'loader', 'src/user.ts'),
      node('9', 'ñandú', 'src/user.ts'),
      node('10', '日本語', 'src/user.ts'),
      node('11', 'user.ts', 'src/user.ts', { kind: 'file', qualifiedName: 'src/user.ts' }),
    ]);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const names = (query: string, opts?: Parameters<typeof searchSymbols>[2]): string[] =>
    searchSymbols(q, query, opts).map((r) => r.node.name);

  it('ranks exact name before longer prefix matches', () => {
    const r = names('getUser');
    expect(r.indexOf('getUser')).toBe(0);
    expect(r).toContain('getUserById');
    expect(r.indexOf('getUser')).toBeLessThan(r.indexOf('getUserById'));
  });

  it('finds camelCase names through segments', () => {
    expect(names('user by id')).toContain('getUserById');
    expect(names('user by id')[0]).toBe('getUserById');
  });

  it('matches docstrings as the lowest tier', () => {
    q.insertNodes([
      node('d1', 'zorkB', 'src/user.ts', { docstring: 'about zork things' }),
      node('d2', 'zorkA', 'src/user.ts'),
    ]);
    expect(names('zork')).toEqual(['zorkB', 'zorkA']);
  });

  it('never throws on hostile queries', () => {
    for (const bad of ['foo"bar -x', '(((', 'AND OR NOT', '"', '*', 'a:b', '^x', 'NEAR(a b)', "it's", '{}']) {
      expect(() => searchSymbols(q, bad)).not.toThrow();
      expect(() => searchSymbols(q, bad, { useFts: false })).not.toThrow();
    }
  });

  it('filters by kinds', () => {
    expect(names('user', { kinds: ['class'] })).toEqual(['UserService']);
  });

  it('excludes test files when includeTests is false', () => {
    expect(names('getUserMock')).toEqual(['getUserMock']);
    expect(names('getUserMock', { includeTests: false })).toEqual([]);
  });

  it('excludes generated files by default and includes them with the flag', () => {
    expect(names('GeneratedUserClient')).toEqual([]);
    expect(names('GeneratedUserClient', { includeGenerated: true })).toEqual(['GeneratedUserClient']);
  });

  it('penalises tests below equivalent production symbols', () => {
    const r = names('getUser');
    expect(r.indexOf('getUserMock')).toBeGreaterThan(r.indexOf('getUserById'));
  });

  it('returns [] for empty queries', () => {
    expect(searchSymbols(q, '')).toEqual([]);
    expect(searchSymbols(q, '   ')).toEqual([]);
    expect(searchSymbols(q, 'AND')).toEqual([]);
  });

  it('honours and clamps limit', () => {
    expect(searchSymbols(q, 'user', { limit: 2 })).toHaveLength(2);
    expect(searchSymbols(q, 'user', { limit: 0 }).length).toBeGreaterThan(0);
    expect(searchSymbols(q, 'user', { limit: 100000 }).length).toBeLessThanOrEqual(200);
  });

  it('returns file nodes only when there are no symbol hits', () => {
    expect(searchSymbols(q, 'user').some((r) => r.node.kind === 'file')).toBe(false);
    q.insertNodes([
      node('f2', 'config.json', 'config.json', { kind: 'file', qualifiedName: 'config.json' }),
    ]);
    expect(names('config')).toEqual(['config.json']);
  });

  it('sorts by score desc with deterministic tie-break', () => {
    const r = searchSymbols(q, 'user');
    for (let i = 1; i < r.length; i++) {
      const prev = r[i - 1];
      const cur = r[i];
      expect(prev && cur && prev.score >= cur.score).toBe(true);
    }
    expect(searchSymbols(q, 'user')).toEqual(r);
  });

  it('useFts:false returns the same top-3 as FTS', () => {
    for (const query of ['getUser', 'user', 'user by id', 'getUserById']) {
      const fts = names(query).slice(0, 3);
      const sub = names(query, { useFts: false }).slice(0, 3);
      expect(sub).toEqual(fts);
    }
  });

  it('falls back automatically when nodes_fts is missing', () => {
    const expected = names('getUser');
    db.exec('DROP TRIGGER nodes_ai; DROP TRIGGER nodes_ad; DROP TRIGGER nodes_au; DROP TABLE nodes_fts');
    expect(names('getUser')).toEqual(expected);
  });

  it('handles unicode identifiers', () => {
    expect(names('ñandú')).toEqual(['ñandú']);
    expect(names('日本語')).toEqual(['日本語']);
    expect(names('ñandú', { useFts: false })).toEqual(['ñandú']);
  });

  it('finds names containing % or _ literally in the fallback', () => {
    expect(names('100%', { useFts: false })).toEqual(['save_100%']);
    expect(names('save_100', { useFts: false })).toContain('save_100%');
  });

  it('finds symbols produced by the real TS extractor', async () => {
    const rel = 'src/real.ts';
    const source =
      'export class OrderRepository { findOrderById(id: string) { return id; } }\nexport function buildOrderReport() {}\n';
    const lang = languageForPath(rel);
    const extractor = lang ? extractorFor(lang) : undefined;
    if (!lang || !extractor) throw new Error('no ts extractor');
    const parser = await createParser(lang, grammarVariantForPath(rel));
    const tree = parser.parse(source);
    if (!tree) throw new Error('no tree');
    const out = extractor.extract(rel, source, tree);
    tree.delete();
    parser.delete();
    q.upsertFile(fileRow(rel));
    q.insertNodes(out.nodes);
    expect(names('order repository')[0]).toBe('OrderRepository');
    expect(names('findOrder')).toContain('findOrderById');
    expect(names('order report', { useFts: false })[0]).toBe('buildOrderReport');
  });

  it('answers a prefix query over 50k nodes in under 300 ms', () => {
    q.upsertFile(fileRow('src/big.ts'));
    q.transaction(() => {
      const batch: GraphNode[] = [];
      for (let i = 0; i < 50000; i++) {
        batch.push(node(`big${i}`, `symbol${i}Handler`, 'src/big.ts', { isExported: false }));
        if (batch.length === 1000) q.insertNodes(batch.splice(0));
      }
    });
    searchSymbols(q, 'symbol4');
    const t0 = performance.now();
    const r = searchSymbols(q, 'symbol4');
    const ms = performance.now() - t0;
    expect(r.length).toBe(20);
    expect(ms).toBeLessThan(300);
  }, 60000);
});
