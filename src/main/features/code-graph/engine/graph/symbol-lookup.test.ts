import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lookupSymbol } from './symbol-lookup';
import { mkNode, openTempDb, seedGraph, type SeededDb } from './test-graph';

let t: SeededDb;
beforeEach(() => {
  t = openTempDb();
});
afterEach(() => t.close());

const ids = (ns: { id: string }[]): string[] => ns.map((n) => n.id);

describe('lookupSymbol', () => {
  it('returns all overloads of a plain name', () => {
    seedGraph(
      t.q,
      [
        mkNode('r1', {
          name: 'run',
          qualifiedName: 'Foo.run',
          filePath: 'src/a.ts',
        }),
        mkNode('r2', {
          name: 'run',
          qualifiedName: 'Bar.run',
          filePath: 'src/b.ts',
        }),
        mkNode('x', { name: 'runner', qualifiedName: 'runner' }),
      ],
      [],
    );
    expect(ids(lookupSymbol(t.q, 'run'))).toEqual(['r1', 'r2']);
    expect(lookupSymbol(t.q, 'missing')).toEqual([]);
  });

  it('matches qualified-name suffixes only at segment boundaries', () => {
    seedGraph(
      t.q,
      [
        mkNode('ts', {
          name: 'run',
          qualifiedName: 'Foo.run',
          filePath: 'src/a.ts',
        }),
        mkNode('java', {
          name: 'run',
          qualifiedName: 'com.acme.Foo.run',
          filePath: 'src/J.java',
        }),
        mkNode('py', {
          name: 'run',
          qualifiedName: 'pkg.mod.Foo.run',
          filePath: 'src/m.py',
        }),
        mkNode('other', {
          name: 'run',
          qualifiedName: 'Boo.run',
          filePath: 'src/o.ts',
        }),
      ],
      [],
    );
    expect(ids(lookupSymbol(t.q, 'Foo.run')).sort()).toEqual([
      'java',
      'py',
      'ts',
    ]);
    expect(ids(lookupSymbol(t.q, 'acme.Foo.run'))).toEqual(['java']);
    expect(lookupSymbol(t.q, 'oo.run')).toEqual([]);
  });

  it('orders exact > exported > near directory > path', () => {
    seedGraph(
      t.q,
      [
        mkNode('far', {
          name: 'go',
          qualifiedName: 'Z.go',
          filePath: 'a/far.ts',
        }),
        mkNode('near', {
          name: 'go',
          qualifiedName: 'Y.go',
          filePath: 'z/near.ts',
        }),
        mkNode('exp', {
          name: 'go',
          qualifiedName: 'X.go',
          filePath: 'm/exp.ts',
          isExported: true,
        }),
        mkNode('exact', {
          name: 'go',
          qualifiedName: 'go',
          filePath: 'q/exact.ts',
        }),
      ],
      [],
    );
    expect(ids(lookupSymbol(t.q, 'go', { near: 'z/other.ts' }))).toEqual([
      'exact',
      'exp',
      'near',
      'far',
    ]);
    expect(ids(lookupSymbol(t.q, 'go'))).toEqual([
      'exact',
      'exp',
      'far',
      'near',
    ]);
  });

  it('supports file#name with a path suffix, and file/kind filters', () => {
    seedGraph(
      t.q,
      [
        mkNode('a', { name: 'run', filePath: 'pkg/src/a.ts' }),
        mkNode('b', { name: 'run', filePath: 'pkg/src/b.ts' }),
        mkNode('m', {
          name: 'run',
          kind: 'method',
          qualifiedName: 'K.run',
          filePath: 'pkg/src/b.ts',
        }),
      ],
      [],
    );
    expect(ids(lookupSymbol(t.q, 'a.ts#run'))).toEqual(['a']);
    expect(ids(lookupSymbol(t.q, 'src/b.ts#run')).sort()).toEqual(['b', 'm']);
    expect(ids(lookupSymbol(t.q, 'src/b.ts#K.run'))).toEqual(['m']);
    expect(ids(lookupSymbol(t.q, 'run', { file: 'src/a.ts' }))).toEqual(['a']);
    expect(ids(lookupSymbol(t.q, 'run', { kind: 'method' }))).toEqual(['m']);
    expect(lookupSymbol(t.q, 'zzz.ts#run')).toEqual([]);
  });

  it('does not scan file paths for dotted symbol queries', () => {
    seedGraph(
      t.q,
      [
        mkNode('f', {
          kind: 'file',
          name: 'a.ts',
          qualifiedName: 'src/a.ts',
          filePath: 'src/a.ts',
        }),
        mkNode('m', {
          kind: 'method',
          name: 'run',
          qualifiedName: 'Foo.run',
          filePath: 'src/a.ts',
        }),
      ],
      [],
    );
    let calls = 0;
    const original = t.q.filePaths.bind(t.q);
    t.q.filePaths = () => {
      calls++;
      return original();
    };
    expect(ids(lookupSymbol(t.q, 'Foo.run'))).toEqual(['m']);
    expect(calls).toBe(0);
    expect(ids(lookupSymbol(t.q, 'src/a.ts'))).toEqual(['f']);
    expect(calls).toBe(1);
  });

  it('excludes file nodes unless the query is a path or kind is file', () => {
    seedGraph(
      t.q,
      [
        mkNode('f', {
          kind: 'file',
          name: 'a.ts',
          qualifiedName: 'src/a.ts',
          filePath: 'src/a.ts',
        }),
        mkNode('s', { name: 'a', qualifiedName: 'a', filePath: 'src/a.ts' }),
      ],
      [],
    );
    expect(ids(lookupSymbol(t.q, 'a.ts'))).toEqual(['f']);
    expect(ids(lookupSymbol(t.q, 'src/a.ts'))).toEqual(['f']);
    expect(ids(lookupSymbol(t.q, 'a'))).toEqual(['s']);
    expect(ids(lookupSymbol(t.q, 'a.ts', { kind: 'file' }))).toEqual(['f']);
  });
});
