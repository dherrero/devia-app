import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  EdgeKind,
  GraphNode,
  NodeKind,
} from '../../../../../shared/domain/code-graph';
import { openGraphDb, type GraphDb } from '../db/connection';
import { GraphQueries, type UnresolvedRef } from '../db/queries';
import {
  createParser,
  grammarVariantForPath,
  languageForPath,
} from '../extraction/grammars';
import { makeNodeId } from '../extraction/node-id';
import { extractorFor } from '../extraction/registry';
import { resolveReferences } from './resolver';

let root: string;
let dataDir: string;
let db: GraphDb;
let q: GraphQueries;

function required<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

async function addFiles(files: Record<string, string>): Promise<void> {
  for (const [rel, source] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, source);
    const lang = languageForPath(rel);
    if (!lang) continue;
    const extractor = required(extractorFor(lang), `extractor for ${lang}`);
    const parser = await createParser(lang, grammarVariantForPath(rel));
    const tree = required(parser.parse(source), 'tree');
    try {
      const ex = extractor.extract(rel, source, tree);
      q.transaction(() => {
        q.upsertFile({
          path: rel,
          contentHash: 'h',
          language: lang,
          size: source.length,
          modifiedAt: 1,
          indexedAt: 1,
          nodeCount: ex.nodes.length,
          generated: false,
          isTest: false,
        });
        q.insertNodes(ex.nodes);
        q.insertEdges(ex.edges);
        q.insertUnresolved(ex.unresolved);
      });
    } finally {
      tree.delete();
      parser.delete();
    }
  }
}

function writeRaw(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function sym(file: string, qualifiedName: string, kind?: NodeKind): GraphNode {
  const found = q
    .nodesInFile(file)
    .filter(
      (n) =>
        n.qualifiedName === qualifiedName &&
        (kind === undefined || n.kind === kind),
    );
  if (found.length !== 1) {
    const seen = q
      .nodesInFile(file)
      .map((n) => `${n.kind}:${n.qualifiedName}`)
      .join(', ');
    throw new Error(
      `expected one ${qualifiedName} in ${file}, got ${found.length} (${seen})`,
    );
  }
  return required(found[0], qualifiedName);
}

function fileId(file: string): string {
  return makeNodeId(file, 'file', file, 1);
}

function targets(sourceId: string, kind: EdgeKind): string[] {
  return q.edgesFrom(sourceId, [kind]).map((e) => e.target);
}

function allRefs(): UnresolvedRef[] {
  return [
    ...q.unresolvedByStatus('pending'),
    ...q.unresolvedByStatus('failed'),
  ];
}

function refsNamed(name: string): UnresolvedRef[] {
  return allRefs().filter((r) => r.referenceName === name);
}

function distinctTargets(sourceId: string, kind: EdgeKind): string[] {
  return [...new Set(targets(sourceId, kind))].sort();
}

function edgeCount(): number {
  return q.counts().edges;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-res-root-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-res-data-'));
  db = openGraphDb(path.join(dataDir, 'graph.db'));
  q = new GraphQueries(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('resolveReferences — TypeScript imports', () => {
  it('links a named import call to the exported function and the files with imports', async () => {
    await addFiles({
      'src/a.ts':
        "import { f } from './b';\nexport function a(): void {\n  f();\n}\n",
      'src/b.ts': 'export function f(): void {}\n',
    });
    const stats = await resolveReferences(q, root);
    const a = sym('src/a.ts', 'a');
    const f = sym('src/b.ts', 'f');
    expect(targets(a.id, 'calls')).toEqual([f.id]);
    expect(targets(fileId('src/a.ts'), 'imports')).toEqual([
      fileId('src/b.ts'),
    ]);
    expect(stats.resolved).toBe(2);
    expect(stats.failed).toBe(0);
    expect(allRefs()).toEqual([]);
  });

  it('resolves a tsconfig paths alias', async () => {
    writeRaw(
      'tsconfig.json',
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/*"] } } }',
    );
    await addFiles({
      'src/main.ts':
        "import { fmt } from '@app/util';\nexport const out = fmt();\n",
      'src/app/util.ts': 'export function fmt(): string { return ""; }\n',
    });
    await resolveReferences(q, root);
    expect(targets(fileId('src/main.ts'), 'imports')).toEqual([
      fileId('src/app/util.ts'),
    ]);
    expect(targets(fileId('src/main.ts'), 'calls')).toEqual([
      sym('src/app/util.ts', 'fmt').id,
    ]);
  });

  it('maps ESM-style .js specifiers to the .ts source', async () => {
    await addFiles({
      'src/a.ts': "import { f } from './b.js';\nf();\n",
      'src/b.ts': 'export function f(): void {}\n',
    });
    await resolveReferences(q, root);
    expect(targets(fileId('src/a.ts'), 'calls')).toEqual([
      sym('src/b.ts', 'f').id,
    ]);
  });

  it('resolves aliased, default and namespace imports', async () => {
    await addFiles({
      'src/a.ts': [
        "import make, { f as g } from './b';",
        "import * as u from './u';",
        'export function a(): void {',
        '  g();',
        '  make();',
        '  u.helper();',
        '  u.Tool.run();',
        '}',
      ].join('\n'),
      'src/b.ts':
        'export function f(): void {}\nexport default function build(): void {}\n',
      'src/u.ts':
        'export function helper(): void {}\nexport class Tool { static run(): void {} }\n',
    });
    await resolveReferences(q, root);
    const a = sym('src/a.ts', 'a');
    expect(targets(a.id, 'calls').sort()).toEqual(
      [
        sym('src/b.ts', 'f').id,
        sym('src/b.ts', 'build').id,
        sym('src/u.ts', 'helper').id,
        sym('src/u.ts', 'Tool.run').id,
      ].sort(),
    );
  });

  it('follows barrel re-exports, renamed exports and export-star', async () => {
    await addFiles({
      'src/a.ts': "import { f, g2, h } from './lib';\nf();\ng2();\nh();\n",
      'src/lib/index.ts':
        "export { f } from './f';\nexport { g as g2 } from './g';\nexport * from './h';\n",
      'src/lib/f.ts': 'export function f(): void {}\n',
      'src/lib/g.ts': 'export function g(): void {}\n',
      'src/lib/h.ts':
        'function hidden(): void {}\nfunction h(): void { hidden(); }\nexport { h };\n',
    });
    await resolveReferences(q, root);
    expect(targets(fileId('src/a.ts'), 'calls').sort()).toEqual(
      [
        sym('src/lib/f.ts', 'f').id,
        sym('src/lib/g.ts', 'g').id,
        sym('src/lib/h.ts', 'h', 'function').id,
      ].sort(),
    );
    expect(targets(fileId('src/lib/index.ts'), 'imports').sort()).toEqual(
      [
        fileId('src/lib/f.ts'),
        fileId('src/lib/g.ts'),
        fileId('src/lib/h.ts'),
      ].sort(),
    );
    expect(targets(sym('src/lib/h.ts', 'h', 'function').id, 'calls')).toEqual([
      sym('src/lib/h.ts', 'hidden').id,
    ]);
  });

  it('resolves an export default identifier and a renamed local export', async () => {
    await addFiles({
      'src/a.ts': "import D, { pub } from './b';\nD();\npub();\n",
      'src/b.ts':
        'function inner(): void {}\nfunction other(): void {}\nexport default inner;\nexport { other as pub };\n',
    });
    await resolveReferences(q, root);
    expect(targets(fileId('src/a.ts'), 'calls').sort()).toEqual(
      [sym('src/b.ts', 'inner').id, sym('src/b.ts', 'other').id].sort(),
    );
  });

  it('resolves new/extends/implements/JSX through imports', async () => {
    await addFiles({
      'src/base.ts': 'export class Base {}\nexport interface Shape {}\n',
      'src/button.tsx': 'export function Button() { return <div/>; }\n',
      'src/a.tsx': [
        "import { Base, Shape } from './base';",
        "import { Button } from './button';",
        'export class Sq extends Base implements Shape {}',
        'export function App() { new Sq(); return <Button/>; }',
      ].join('\n'),
    });
    await resolveReferences(q, root);
    const sq = sym('src/a.tsx', 'Sq');
    const app = sym('src/a.tsx', 'App');
    expect(targets(sq.id, 'extends')).toEqual([sym('src/base.ts', 'Base').id]);
    expect(targets(sq.id, 'implements')).toEqual([
      sym('src/base.ts', 'Shape').id,
    ]);
    expect(targets(app.id, 'instantiates')).toEqual([sq.id]);
    expect(targets(app.id, 'references')).toEqual([
      sym('src/button.tsx', 'Button').id,
    ]);
  });

  it('leaves external packages failed without nodes or errors, and they shadow project names', async () => {
    await addFiles({
      'src/a.ts':
        "import React, { useState } from 'react';\nexport function A(): void {\n  useState();\n  React.createElement();\n}\n",
      'src/hooks.ts': 'export function useState(): void {}\n',
    });
    const before = q.counts().nodes;
    const stats = await resolveReferences(q, root);
    expect(q.counts().nodes).toBe(before);
    expect(targets(sym('src/a.ts', 'A').id, 'calls')).toEqual([]);
    expect(stats.resolved).toBe(0);
    const failed = q.unresolvedByStatus('failed');
    expect(failed.map((r) => r.referenceName).sort()).toEqual([
      'React.createElement',
      'react',
      'react',
      'useState',
    ]);
    expect(failed.find((r) => r.referenceName === 'useState')?.nameTail).toBe(
      'useState',
    );
  });

  it('does not guess between two same-named functions and marks the call failed', async () => {
    await addFiles({
      'src/x/one.js': 'function helper() {}\n',
      'src/y/two.js': 'function helper() {}\n',
      'src/main.js': 'helper();\n',
    });
    await resolveReferences(q, root);
    expect(targets(fileId('src/main.js'), 'calls')).toEqual([]);
    const [ref] = refsNamed('helper');
    expect(ref?.status).toBe('failed');
    expect(ref?.nameTail).toBe('helper');
  });

  it('breaks a tie by same directory, and links a unique global name in script files', async () => {
    await addFiles({
      'src/x/one.js': 'function helper() {}\nfunction only() {}\n',
      'src/y/two.js': 'function helper() {}\n',
      'src/y/main.js': 'helper();\nonly();\n',
    });
    await resolveReferences(q, root);
    expect(targets(fileId('src/y/main.js'), 'calls').sort()).toEqual(
      [sym('src/y/two.js', 'helper').id, sym('src/x/one.js', 'only').id].sort(),
    );
    expect(
      q
        .edgesFrom(fileId('src/y/main.js'), ['calls'])
        .every((e) => e.provenance === 'heuristic'),
    ).toBe(true);
  });

  it('does not link a name an ES module never imported', async () => {
    await addFiles({
      'src/a.ts':
        "import { x } from './x';\nexport function a(): void { x(); stray(); }\n",
      'src/x.ts': 'export function x(): void {}\n',
      'src/other.ts': 'export function stray(): void {}\n',
    });
    await resolveReferences(q, root);
    expect(targets(sym('src/a.ts', 'a').id, 'calls')).toEqual([
      sym('src/x.ts', 'x').id,
    ]);
    expect(refsNamed('stray')[0]?.status).toBe('failed');
  });
});

describe('resolveReferences — same file and scope (TypeScript)', () => {
  it('resolves local calls, this-members, inherited members, overloads and decorators', async () => {
    await addFiles({
      'src/base.ts': 'export class Base {\n  protected shared(): void {}\n}\n',
      'src/a.ts': [
        "import { Base } from './base';",
        'function sealed(target: unknown): void {}',
        'function f(a: string): void;',
        'function f(a: number): void;',
        'function f(a: unknown): void {}',
        '@sealed',
        'export class A extends Base {',
        '  run(): void {',
        '    this.helper();',
        '    this.shared();',
        '    super.shared();',
        '    f(1);',
        '    this.missing();',
        '  }',
        '  helper(): void {}',
        '}',
      ].join('\n'),
    });
    await resolveReferences(q, root);
    const run = sym('src/a.ts', 'A.run');
    const shared = sym('src/base.ts', 'Base.shared');
    const impl = q
      .nodesInFile('src/a.ts')
      .filter((n) => n.name === 'f')
      .sort((x, y) => y.startLine - x.startLine)[0];
    expect(distinctTargets(run.id, 'calls')).toEqual(
      [
        sym('src/a.ts', 'A.helper').id,
        shared.id,
        required(impl, 'f impl').id,
      ].sort(),
    );
    expect(
      q.edgesFrom(run.id, ['calls']).filter((e) => e.target === shared.id),
    ).toHaveLength(2);
    expect(targets(sym('src/a.ts', 'sealed').id, 'decorates')).toEqual([
      sym('src/a.ts', 'A').id,
    ]);
    expect(refsNamed('this.missing')[0]?.status).toBe('failed');
  });

  it('prefers the innermost lexical declaration and never binds a bare name to a class method', async () => {
    await addFiles({
      'src/a.ts': [
        'export function run(): void {}',
        'export function outer(): void {',
        '  function inner(): void {}',
        '  inner();',
        '}',
        'export function other(): void {',
        '  function inner(): void {}',
        '}',
        'export class K {',
        '  run(): void {}',
        '  go(): void { run(); }',
        '}',
      ].join('\n'),
    });
    await resolveReferences(q, root);
    expect(targets(sym('src/a.ts', 'outer').id, 'calls')).toEqual([
      sym('src/a.ts', 'outer.inner').id,
    ]);
    expect(targets(sym('src/a.ts', 'K.go').id, 'calls')).toEqual([
      sym('src/a.ts', 'run', 'function').id,
    ]);
  });

  it('resolves members of a module-level object literal', async () => {
    await addFiles({
      'src/a.ts':
        'const api = {\n  get(): void {},\n};\nexport function a(): void { api.get(); }\n',
    });
    await resolveReferences(q, root);
    expect(targets(sym('src/a.ts', 'a').id, 'calls')).toEqual([
      sym('src/a.ts', 'api.get').id,
    ]);
  });

  it('drops receiver calls on unknown objects instead of matching by member name', async () => {
    await addFiles({
      'src/a.ts':
        'export function a(list: number[]): void { list.push(1); console.log(1); }\n',
      'src/b.ts':
        'export class Stack { push(): void {} }\nexport function log(): void {}\n',
    });
    await resolveReferences(q, root);
    expect(targets(sym('src/a.ts', 'a').id, 'calls')).toEqual([]);
  });
});

describe('resolveReferences — run modes', () => {
  it('is idempotent', async () => {
    await addFiles({
      'src/a.ts': "import { f } from './b';\nf();\nf();\n",
      'src/b.ts': 'export function f(): void {}\n',
    });
    expect((await resolveReferences(q, root)).resolved).toBe(3);
    const edges = edgeCount();
    const second = await resolveReferences(q, root);
    expect(second).toEqual({ resolved: 0, failed: 0, skippedImplements: 0 });
    expect(edgeCount()).toBe(edges);
  });

  it('with onlyFiles touches only those files and leaves other pending refs alone', async () => {
    await addFiles({
      'src/a.ts': 'export function a(): void {}\n',
      'src/b.ts':
        "import { a } from './a';\nexport function b(): void { a(); }\n",
    });
    await resolveReferences(q, root);
    await addFiles({
      'src/c.ts':
        "import { a } from './a';\nexport function c(): void { a(); }\n",
      'src/d.ts':
        "import { a } from './a';\nexport function d(): void { a(); }\n",
    });
    const stats = await resolveReferences(q, root, ['src/c.ts']);
    expect(stats).toEqual({ resolved: 2, failed: 0, skippedImplements: 0 });
    expect(targets(sym('src/c.ts', 'c').id, 'calls')).toEqual([
      sym('src/a.ts', 'a').id,
    ]);
    expect(targets(sym('src/d.ts', 'd').id, 'calls')).toEqual([]);
    expect(
      q.unresolvedByStatus('pending').every((r) => r.filePath === 'src/d.ts'),
    ).toBe(true);
    expect(q.unresolvedByStatus('pending')).toHaveLength(2);
    const edges = edgeCount();
    await resolveReferences(q, root, ['src/c.ts']);
    expect(edgeCount()).toBe(edges);
  });

  it('retries failed refs elsewhere when onlyFiles introduces the symbol', async () => {
    await addFiles({
      'src/a.ts':
        "import { later } from './b';\nimport { sibling } from './c';\nexport function a(): void { later(); sibling(); }\n",
      'src/c.ts': 'export function other(): void {}\n',
    });
    const first = await resolveReferences(q, root);
    expect(first).toEqual({ resolved: 0, failed: 4, skippedImplements: 0 });
    expect(targets(fileId('src/a.ts'), 'imports')).toEqual([
      fileId('src/c.ts'),
    ]);
    expect(
      q
        .unresolvedByStatus('failed')
        .map((r) => r.referenceName)
        .sort(),
    ).toEqual(['./b', './c', 'later', 'sibling']);

    await addFiles({ 'src/b.ts': 'export function later(): void {}\n' });
    await resolveReferences(q, root, ['src/b.ts']);
    const a = sym('src/a.ts', 'a');
    expect(targets(a.id, 'calls')).toEqual([sym('src/b.ts', 'later').id]);
    expect(targets(fileId('src/a.ts'), 'imports').sort()).toEqual(
      [fileId('src/b.ts'), fileId('src/c.ts')].sort(),
    );
    expect(
      q
        .unresolvedByStatus('failed')
        .map((r) => r.referenceName)
        .sort(),
    ).toEqual(['./c', 'sibling']);
    expect(q.unresolvedByStatus('pending')).toEqual([]);

    db.prepare("DELETE FROM nodes WHERE file_path = 'src/c.ts'").run();
    await addFiles({ 'src/c.ts': 'export function sibling(): void {}\n' });
    await resolveReferences(q, root, ['src/c.ts']);
    expect(targets(a.id, 'calls').sort()).toEqual(
      [sym('src/b.ts', 'later').id, sym('src/c.ts', 'sibling').id].sort(),
    );
    expect(allRefs()).toEqual([]);
  });

  it('creates exports edges file to file', async () => {
    await addFiles({
      'src/a.ts': 'export function a(): void {}\n',
      'src/b.ts': 'export function b(): void {}\n',
    });
    q.insertUnresolved([
      {
        fromNodeId: fileId('src/b.ts'),
        referenceName: './a',
        referenceKind: 'exports',
        line: 1,
        col: 0,
        filePath: 'src/b.ts',
        language: 'typescript',
        status: 'pending',
        nameTail: './a',
      },
    ]);
    await resolveReferences(q, root);
    expect(targets(fileId('src/b.ts'), 'exports')).toEqual([
      fileId('src/a.ts'),
    ]);
  });
});

describe('resolveReferences — other languages, same file', () => {
  it('Python: calls, self-members, bases and decorators; relative imports resolve', async () => {
    await addFiles({
      'pkg/app.py': [
        'from .utils import tool',
        'def deco(fn):',
        '    return fn',
        'def helper():',
        '    pass',
        'class A:',
        '    def base(self):',
        '        pass',
        'class B(A):',
        '    @deco',
        '    def run(self):',
        '        helper()',
        '        self.base()',
        '        self.go()',
        '        tool()',
        '    def go(self):',
        '        pass',
      ].join('\n'),
      'pkg/utils.py': 'def tool():\n    pass\n',
    });
    await resolveReferences(q, root);
    const run = sym('pkg/app.py', 'pkg.app.B.run');
    expect(targets(run.id, 'calls').sort()).toEqual(
      [
        sym('pkg/app.py', 'pkg.app.helper').id,
        sym('pkg/app.py', 'pkg.app.A.base').id,
        sym('pkg/app.py', 'pkg.app.B.go').id,
        sym('pkg/utils.py', 'pkg.utils.tool').id,
      ].sort(),
    );
    expect(targets(sym('pkg/app.py', 'pkg.app.B').id, 'extends')).toEqual([
      sym('pkg/app.py', 'pkg.app.A').id,
    ]);
    expect(targets(sym('pkg/app.py', 'pkg.app.deco').id, 'decorates')).toEqual([
      run.id,
    ]);
    expect(targets(fileId('pkg/app.py'), 'imports')).toEqual([
      fileId('pkg/utils.py'),
    ]);
  });

  it('Go: same-file calls, receiver methods, composite literals; builtins are dropped', async () => {
    await addFiles({
      'cmd/main.go': [
        'package main',
        'type S struct{ n int }',
        'func helper(xs []int) int { return len(xs) }',
        'func (s *S) Run() {',
        '  helper(nil)',
        '  s.Stop()',
        '  _ = int(3)',
        '  _ = append([]int{}, 1)',
        '  _ = S{}',
        '}',
        'func (s *S) Stop() {}',
      ].join('\n'),
      'cmd/other.go': 'package main\nfunc (s *S) Far() { s.Run() }\n',
    });
    await resolveReferences(q, root);
    const run = sym('cmd/main.go', 'S.Run');
    expect(targets(run.id, 'calls').sort()).toEqual(
      [sym('cmd/main.go', 'helper').id, sym('cmd/main.go', 'S.Stop').id].sort(),
    );
    expect(targets(run.id, 'instantiates')).toEqual([
      sym('cmd/main.go', 'S').id,
    ]);
    expect(targets(sym('cmd/other.go', 'S.Far').id, 'calls')).toEqual([run.id]);
    for (const builtin of ['len', 'int', 'append'])
      expect(refsNamed(builtin)).toEqual([]);
  });

  it('Java: implicit this, inherited members, nested types, overrides', async () => {
    await addFiles({
      'src/com/acme/A.java': [
        'package com.acme;',
        'class B {',
        '  void run() {}',
        '  void shared() {}',
        '}',
        'public class A extends B {',
        '  static class Inner {}',
        '  @Override',
        '  public void run() {',
        '    helper();',
        '    shared();',
        '    this.helper();',
        '    new Inner();',
        '    Util.make();',
        '    list.add(1);',
        '  }',
        '  void helper() {}',
        '}',
        'class Util { static void make() {} }',
      ].join('\n'),
    });
    await resolveReferences(q, root);
    const run = sym('src/com/acme/A.java', 'com.acme.A.run');
    const helper = sym('src/com/acme/A.java', 'com.acme.A.helper').id;
    expect(distinctTargets(run.id, 'calls')).toEqual(
      [
        helper,
        sym('src/com/acme/A.java', 'com.acme.B.shared').id,
        sym('src/com/acme/A.java', 'com.acme.Util.make').id,
      ].sort(),
    );
    expect(
      q.edgesFrom(run.id, ['calls']).filter((e) => e.target === helper),
    ).toHaveLength(2);
    expect(targets(run.id, 'instantiates')).toEqual([
      sym('src/com/acme/A.java', 'com.acme.A.Inner').id,
    ]);
    expect(targets(run.id, 'overrides')).toEqual([
      sym('src/com/acme/A.java', 'com.acme.B.run').id,
    ]);
    expect(
      targets(sym('src/com/acme/A.java', 'com.acme.A').id, 'extends'),
    ).toEqual([sym('src/com/acme/A.java', 'com.acme.B').id]);
    expect(refsNamed('list.add')[0]?.status).toBe('failed');
  });

  it('Dart: constructors, static members via Upper.lower, function calls that look like constructors', async () => {
    await addFiles({
      'lib/main.dart': [
        "import 'package:flutter/material.dart';",
        'class Counter extends StatefulWidget {',
        '  @override',
        '  State<Counter> createState() => _CounterState();',
        '}',
        'class _CounterState extends State<Counter> {',
        '  void tap() {',
        '    Nav.of(1);',
        '    Point.origin();',
        '    BuildThing();',
        '    helper();',
        '  }',
        '}',
        'class Nav { static Nav of(int x) => Nav(); }',
        'class Point { Point.origin(); }',
        'void BuildThing() {}',
        'void helper() {}',
      ].join('\n'),
    });
    await resolveReferences(q, root);
    const createState = sym('lib/main.dart', 'Counter.createState');
    const state = sym('lib/main.dart', '_CounterState');
    expect(targets(createState.id, 'instantiates')).toEqual([state.id]);
    const tap = sym('lib/main.dart', '_CounterState.tap');
    expect(targets(tap.id, 'calls').sort()).toEqual(
      [
        sym('lib/main.dart', 'Nav.of').id,
        sym('lib/main.dart', 'BuildThing').id,
        sym('lib/main.dart', 'helper').id,
      ].sort(),
    );
    expect(targets(tap.id, 'instantiates')).toEqual([
      sym('lib/main.dart', 'Point').id,
    ]);
    expect(refsNamed('StatefulWidget')[0]?.status).toBe('failed');
    expect(refsNamed('package:flutter/material.dart')[0]?.status).toBe(
      'failed',
    );
  });
});

describe('resolveReferences — scale', () => {
  it('resolves ~20k nodes / 60k refs within the budget', async () => {
    const files = 400;
    const perFile = 50;
    q.transaction(() => {
      for (let f = 0; f < files; f++) {
        const filePath = `src/m${f % 20}/f${f}.js`;
        q.upsertFile({
          path: filePath,
          contentHash: 'h',
          language: 'javascript',
          size: 1,
          modifiedAt: 1,
          indexedAt: 1,
          nodeCount: perFile,
          generated: false,
          isTest: false,
        });
        const file: GraphNode = {
          id: fileId(filePath),
          kind: 'file',
          name: `f${f}.js`,
          qualifiedName: filePath,
          filePath,
          language: 'javascript',
          startLine: 1,
          endLine: perFile * 2,
          isExported: false,
        };
        const nodes: GraphNode[] = [file];
        const refs: UnresolvedRef[] = [];
        for (let i = 0; i < perFile - 1; i++) {
          const name = i % 10 === 0 ? `common${i}` : `fn_${f}_${i}`;
          const n: GraphNode = {
            id: makeNodeId(filePath, 'function', name, i + 2),
            kind: 'function',
            name,
            qualifiedName: name,
            filePath,
            language: 'javascript',
            startLine: i + 2,
            endLine: i + 2,
            isExported: false,
          };
          nodes.push(n);
          for (let r = 0; r < 3; r++) {
            const target =
              r === 0
                ? `fn_${f}_${(i + 1) % (perFile - 1)}`
                : r === 1
                  ? `fn_${(f + 1) % files}_${i}`
                  : `common${i - (i % 10)}`;
            refs.push({
              fromNodeId: n.id,
              referenceName: target,
              referenceKind: 'calls',
              line: i + 2,
              col: r,
              filePath,
              language: 'javascript',
              status: 'pending',
              nameTail: target,
            });
          }
        }
        q.insertNodes(nodes);
        q.insertEdges(
          nodes.slice(1).map((n) => ({
            source: file.id,
            target: n.id,
            kind: 'contains' as const,
          })),
        );
        q.insertUnresolved(refs);
      }
    });
    const started = Date.now();
    const stats = await resolveReferences(q, root);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(stats.resolved + stats.failed).toBe(files * (perFile - 1) * 3);
    expect(stats.resolved).toBeGreaterThan(files * (perFile - 1) * 2);
  }, 180_000);
});
