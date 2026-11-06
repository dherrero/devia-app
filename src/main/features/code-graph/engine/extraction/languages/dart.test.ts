import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  EdgeKind,
  GraphNode,
  NodeKind,
} from '../../../../../../shared/domain/code-graph';
import type { UnresolvedRef } from '../../db/queries';
import type { FileExtraction } from '../extractor';
import {
  createParser,
  grammarVariantForPath,
  languageForPath,
} from '../grammars';
import { extractorFor } from '../registry';

const FIXTURES = path.join(__dirname, '..', '__fixtures__', 'dart');

function required<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

async function extractSource(
  relPath: string,
  source: string,
): Promise<FileExtraction> {
  const lang = required(languageForPath(relPath), `language for ${relPath}`);
  const extractor = required(extractorFor(lang), `extractor for ${lang}`);
  const parser = await createParser(lang, grammarVariantForPath(relPath));
  const tree = required(parser.parse(source), 'tree');
  try {
    return extractor.extract(relPath, source, tree);
  } finally {
    tree.delete();
    parser.delete();
  }
}

function extractFixture(name: string): Promise<FileExtraction> {
  return extractSource(
    `src/${name}`,
    fs.readFileSync(path.join(FIXTURES, name), 'utf8'),
  );
}

function nodeOf(
  ex: FileExtraction,
  kind: NodeKind,
  qualifiedName: string,
): GraphNode {
  const found = ex.nodes.filter(
    (n) => n.kind === kind && n.qualifiedName === qualifiedName,
  );
  if (found.length !== 1) {
    const seen = ex.nodes.map((n) => `${n.kind}:${n.qualifiedName}`).join(', ');
    throw new Error(
      `expected one ${kind} ${qualifiedName}, got ${found.length} (${seen})`,
    );
  }
  return required(found[0], qualifiedName);
}

function refs(ex: FileExtraction, kind: EdgeKind): UnresolvedRef[] {
  return ex.unresolved.filter((u) => u.referenceKind === kind);
}

function refNamed(
  ex: FileExtraction,
  kind: EdgeKind,
  name: string,
): UnresolvedRef {
  return required(
    refs(ex, kind).find((u) => u.referenceName === name),
    `${kind} ref ${name}`,
  );
}

function hasContains(
  ex: FileExtraction,
  parent: GraphNode,
  child: GraphNode,
): boolean {
  return ex.edges.some(
    (e) =>
      e.kind === 'contains' && e.source === parent.id && e.target === child.id,
  );
}

function names(ex: FileExtraction, kind: NodeKind): string[] {
  return ex.nodes.filter((n) => n.kind === kind).map((n) => n.qualifiedName);
}

describe('dartExtractor', () => {
  it('registers for dart', () => {
    expect(extractorFor('dart')?.language).toBe('dart');
  });

  it('models a StatefulWidget as a component with its createState method', async () => {
    const ex = await extractFixture('widgets.dart');
    expect(ex.errors).toEqual([]);
    const file = required(
      ex.nodes.find((n) => n.kind === 'file'),
      'file',
    );
    const counter = nodeOf(ex, 'component', 'Counter');
    expect(hasContains(ex, file, counter)).toBe(true);
    expect(counter.metadata).toEqual({ dartKind: 'class', widget: true });
    expect(counter.docstring).toBe('A counter widget.\nStateful.');
    expect(counter.visibility).toBe('public');
    expect(counter.isExported).toBe(true);
    const ext = refNamed(ex, 'extends', 'StatefulWidget');
    expect(ext.fromNodeId).toBe(counter.id);
    expect(ext.language).toBe('dart');
    expect(ext.status).toBe('pending');

    const createState = nodeOf(ex, 'method', 'Counter.createState');
    expect(hasContains(ex, counter, createState)).toBe(true);
    expect(createState.decorators).toEqual(['override']);
    expect(refNamed(ex, 'decorates', 'override').fromNodeId).toBe(
      createState.id,
    );
    const inst = refNamed(ex, 'instantiates', '_CounterState');
    expect(inst.fromNodeId).toBe(createState.id);

    const state = nodeOf(ex, 'component', '_CounterState');
    expect(state.visibility).toBe('private');
    expect(state.isExported).toBe(false);
    expect(refNamed(ex, 'extends', 'State').fromNodeId).toBe(state.id);
    expect(nodeOf(ex, 'component', 'Hello').metadata).toEqual({
      dartKind: 'class',
      widget: true,
    });
    expect(refNamed(ex, 'extends', 'material.StatelessWidget').nameTail).toBe(
      'StatelessWidget',
    );
    expect(nodeOf(ex, 'component', 'Theme2').metadata?.['widget']).toBe(true);
  });

  it('extracts imports, exports and parts with metadata', async () => {
    const ex = await extractFixture('widgets.dart');
    const file = required(
      ex.nodes.find((n) => n.kind === 'file'),
      'file',
    );
    const material = refNamed(ex, 'imports', 'package:flutter/material.dart');
    expect(material.fromNodeId).toBe(file.id);
    expect(material.metadata).toEqual({
      alias: 'm',
      show: 'Text',
      binding: 'm',
    });
    expect(refNamed(ex, 'imports', '../models/user.dart').metadata).toEqual({
      hide: 'Secret',
    });
    expect(refNamed(ex, 'imports', 'package:lazy/lazy.dart').metadata).toEqual({
      alias: 'lazy',
      deferred: true,
      binding: 'lazy',
    });
    expect(refNamed(ex, 'imports', 'dart:async').metadata).toBeUndefined();
    expect(refNamed(ex, 'exports', 'src/api.dart').metadata).toEqual({
      show: 'Api',
    });
    expect(refNamed(ex, 'imports', 'widgets.g.dart').metadata).toEqual({
      part: true,
    });
    expect(names(ex, 'import')).toContain('package:flutter/material.dart');
    expect(names(ex, 'export')).toEqual(['src/api.dart']);
    expect(ex.nodes.filter((n) => n.kind === 'import')).toHaveLength(4);
  });

  it('extracts members, fields and calls inside widget methods', async () => {
    const ex = await extractFixture('widgets.dart');
    const count = nodeOf(ex, 'field', '_CounterState._count');
    expect(count.visibility).toBe('private');
    expect(nodeOf(ex, 'field', '_CounterState.max').isStatic).toBe(true);
    const build = nodeOf(ex, 'method', '_CounterState.build');
    expect(refs(ex, 'calls').filter((r) => r.fromNodeId === build.id)).toEqual(
      [],
    );
    expect(
      refs(ex, 'instantiates')
        .filter((r) => r.fromNodeId === build.id)
        .map((r) => r.referenceName),
    ).toEqual(['Text', 'm.Text']);
    expect(nodeOf(ex, 'method', 'Hello.build').endLine).toBe(29);
    expect(refNamed(ex, 'instantiates', 'Text').line).toBeGreaterThan(0);
  });

  it('models mixins, extensions, abstract classes and with/implements/on', async () => {
    const ex = await extractFixture('types.dart');
    const m = nodeOf(ex, 'class', 'M');
    expect(m.metadata).toEqual({ dartKind: 'mixin' });
    expect(refNamed(ex, 'extends', 'A').metadata).toEqual({ via: 'on' });
    expect(refNamed(ex, 'extends', 'A').fromNodeId).toBe(m.id);
    const b = nodeOf(ex, 'class', 'B');
    expect(b.metadata).toEqual({ dartKind: 'class' });
    expect(refNamed(ex, 'extends', 'Base').fromNodeId).toBe(b.id);
    const withM = refNamed(ex, 'implements', 'M');
    expect(withM.metadata).toEqual({ via: 'mixin' });
    expect(withM.fromNodeId).toBe(b.id);
    expect(refNamed(ex, 'implements', 'Comparable').metadata).toBeUndefined();
    expect(refNamed(ex, 'implements', 'Other').fromNodeId).toBe(b.id);
    const base = nodeOf(ex, 'class', 'Base');
    expect(base.metadata).toEqual({ dartKind: 'abstract' });
    expect(base.isAbstract).toBe(true);
    expect(nodeOf(ex, 'method', 'Base.run').isAbstract).toBe(true);
    expect(nodeOf(ex, 'class', 'Shape').metadata).toEqual({
      dartKind: 'abstract',
    });
    expect(nodeOf(ex, 'class', 'Both').metadata).toEqual({ dartKind: 'mixin' });
    const ext = nodeOf(ex, 'class', 'StringExt');
    expect(ext.metadata).toEqual({ dartKind: 'extension' });
    expect(hasContains(ex, ext, nodeOf(ex, 'method', 'StringExt.shout'))).toBe(
      true,
    );
    expect(nodeOf(ex, 'class', 'Model').decorators).toEqual([
      'immutable',
      'JsonSerializable',
    ]);
    expect(refNamed(ex, 'decorates', 'JsonSerializable').fromNodeId).toBe(
      nodeOf(ex, 'class', 'Model').id,
    );
  });

  it('models constructors as methods', async () => {
    const ex = await extractFixture('types.dart');
    expect(nodeOf(ex, 'method', 'B.B').metadata).toEqual({ constructor: true });
    expect(nodeOf(ex, 'method', 'B.B.named').metadata).toEqual({
      constructor: true,
    });
    const fromJson = nodeOf(ex, 'method', 'B.B.fromJson');
    expect(fromJson.metadata).toEqual({ constructor: true, factory: true });
    expect(refNamed(ex, 'instantiates', 'B.named').fromNodeId).toBe(
      fromJson.id,
    );
  });

  it('records calls, instantiations, cascades and async flags', async () => {
    const ex = await extractFixture('types.dart');
    const run = nodeOf(ex, 'method', 'B.run');
    const calls = refs(ex, 'calls')
      .filter((r) => r.fromNodeId === run.id)
      .map((r) => r.referenceName);
    expect(calls).toEqual([
      'this.go',
      'other.work',
      'write',
      'writeln',
      'helper',
      'items.map',
      'convert',
    ]);
    const inst = refs(ex, 'instantiates')
      .filter((r) => r.fromNodeId === run.id)
      .map((r) => r.referenceName);
    expect(inst).toEqual(['Foo.named', 'Foo']);
    expect(nodeOf(ex, 'method', 'B.go').isAsync).toBe(true);
    expect(nodeOf(ex, 'method', 'B.gen').isAsync).toBe(true);
    expect(nodeOf(ex, 'method', 'B.it').isAsync).toBe(true);
    expect(nodeOf(ex, 'method', 'B.make').isStatic).toBe(true);
    expect(nodeOf(ex, 'method', 'B.make').isAsync).toBeUndefined();
  });

  it('keeps same-name getter and setter as distinct properties', async () => {
    const ex = await extractFixture('types.dart');
    const props = ex.nodes.filter(
      (n) => n.kind === 'property' && n.qualifiedName === 'B.value',
    );
    expect(props).toHaveLength(2);
    expect(new Set(props.map((p) => p.id)).size).toBe(2);
    expect(props.map((p) => p.metadata)).toEqual([
      { accessor: 'get' },
      { accessor: 'set' },
    ]);
  });

  it('extracts enums, typedefs and top-level declarations', async () => {
    const ex = await extractFixture('types.dart');
    const color = nodeOf(ex, 'enum', 'Color');
    expect(names(ex, 'enum_member')).toEqual(['Color.red', 'Color.green']);
    expect(hasContains(ex, color, nodeOf(ex, 'enum_member', 'Color.red'))).toBe(
      true,
    );
    expect(names(ex, 'type_alias')).toEqual(['IntMap', 'Callback']);
    expect(names(ex, 'constant')).toEqual(['pi', 'version']);
    expect(names(ex, 'variable')).toEqual(['counter', 'total']);
    const file = required(
      ex.nodes.find((n) => n.kind === 'file'),
      'file',
    );
    expect(refNamed(ex, 'calls', 'compute').fromNodeId).toBe(file.id);
    const greet = nodeOf(ex, 'function', 'greet');
    expect(greet.docstring).toBe('Greets.');
    expect(greet.visibility).toBe('public');
    expect(nodeOf(ex, 'function', '_hidden').visibility).toBe('private');
    expect(nodeOf(ex, 'function', '_hidden').isExported).toBe(false);
    expect(refNamed(ex, 'calls', 'print').fromNodeId).toBe(greet.id);
    expect(refNamed(ex, 'calls', 'inner').fromNodeId).toBe(greet.id);
    expect(ex.nodes.some((n) => n.name === 'inner')).toBe(false);
    expect(ex.nodes.some((n) => n.name === 'label')).toBe(false);
  });

  it('keeps partial nodes on syntax errors and a consistent graph', async () => {
    const ex = await extractFixture('syntax_error.dart');
    expect(ex.errors.length).toBeGreaterThan(0);
    nodeOf(ex, 'class', 'Ok');
    nodeOf(ex, 'method', 'Ok.fine');
    const ids = ex.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ex.nodes.length);
    const known = new Set(ids);
    for (const e of ex.edges) {
      expect(known.has(e.source)).toBe(true);
      expect(known.has(e.target)).toBe(true);
    }
    for (const u of ex.unresolved) expect(known.has(u.fromNodeId)).toBe(true);
  });

  it('extracts generated files normally', async () => {
    const ex = await extractSource(
      'lib/user.g.dart',
      'class _$UserFromJson {}\nUser _$UserFromJson2() => User();\n',
    );
    expect(ex.errors).toEqual([]);
    expect(names(ex, 'class')).toEqual(['_$UserFromJson']);
    expect(refNamed(ex, 'instantiates', 'User').fromNodeId).toBe(
      nodeOf(ex, 'function', '_$UserFromJson2').id,
    );
  });

  it('handles part of, annotated top-level functions and unnamed extensions', async () => {
    const ex = await extractSource(
      'lib/part.dart',
      "part of 'lib.dart';\n\n/// Doc.\n@pragma('vm:prefer-inline')\nvoid fast() {}\n\n@deprecated\nconst limit = 3;\n\nextension on int {\n  int twice() => this * 2;\n}\n",
    );
    expect(ex.errors).toEqual([]);
    expect(refNamed(ex, 'imports', 'lib.dart').metadata).toEqual({
      part: true,
    });
    const fast = nodeOf(ex, 'function', 'fast');
    expect(fast.docstring).toBe('Doc.');
    expect(fast.decorators).toEqual(['pragma']);
    expect(refNamed(ex, 'decorates', 'pragma').fromNodeId).toBe(fast.id);
    expect(nodeOf(ex, 'constant', 'limit').decorators).toEqual(['deprecated']);
    nodeOf(ex, 'method', 'extension on int.twice');
  });
});
