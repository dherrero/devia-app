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

const FIXTURES = path.join(__dirname, '..', '__fixtures__', 'java');

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

describe('javaExtractor', () => {
  it('registers for java', () => {
    expect(extractorFor('java')?.language).toBe('java');
  });

  it('extracts the package, a class, its members and qualified names', async () => {
    const ex = await extractFixture('Classes.java');
    expect(ex.errors).toEqual([]);
    const file = required(ex.nodes.find((n) => n.kind === 'file'), 'file');
    const pkg = nodeOf(ex, 'namespace', 'com.acme');
    expect(hasContains(ex, file, pkg)).toBe(true);
    const a = nodeOf(ex, 'class', 'com.acme.A');
    expect(hasContains(ex, pkg, a)).toBe(true);
    expect(a.docstring).toBe('Runs things.\nTwice.');
    expect(a.visibility).toBe('public');
    expect(a.isExported).toBe(true);
    expect(a.decorators).toEqual(['Deprecated']);

    const run = nodeOf(ex, 'method', 'com.acme.A.run');
    expect(hasContains(ex, a, run)).toBe(true);
    expect(run.docstring).toBe('Runs.');
    expect(run.visibility).toBe('public');
    expect(run.decorators).toEqual(['Override']);
    expect(run.signature).toBe('public void run()');

    const ctor = nodeOf(ex, 'method', 'com.acme.A.A');
    expect(ctor.metadata).toEqual({ constructor: true });

    const limit = nodeOf(ex, 'field', 'com.acme.A.LIMIT');
    expect(limit.isStatic).toBe(true);
    expect(limit.visibility).toBe('private');
    expect(limit.isExported).toBe(false);
    expect(nodeOf(ex, 'field', 'com.acme.A.name').visibility).toBe('protected');
    expect(nodeOf(ex, 'field', 'com.acme.A.other').visibility).toBe('protected');
    const pf = nodeOf(ex, 'field', 'com.acme.A.packageField');
    expect(pf.visibility).toBe('package');
    expect(pf.isStatic).toBeUndefined();
    expect(nodeOf(ex, 'method', 'com.acme.A.helper').isStatic).toBe(true);
  });

  it('emits overloads with one qualifiedName, distinct ids and parameter types in the signature', async () => {
    const ex = await extractFixture('Classes.java');
    const overs = ex.nodes.filter((n) => n.kind === 'method' && n.qualifiedName === 'com.acme.A.over');
    expect(overs).toHaveLength(2);
    expect(new Set(overs.map((o) => o.id)).size).toBe(2);
    expect(overs.map((o) => o.signature)).toEqual([
      'void over(int a)',
      'void over(String a, List<String> b)',
    ]);
  });

  it('marks abstract methods', async () => {
    const ex = await extractFixture('Classes.java');
    const abs = nodeOf(ex, 'class', 'com.acme.A.Abs');
    expect(abs.isAbstract).toBe(true);
    expect(abs.isStatic).toBe(true);
    expect(nodeOf(ex, 'method', 'com.acme.A.Abs.todo').isAbstract).toBe(true);
    expect(nodeOf(ex, 'method', 'com.acme.A.Abs.todo').visibility).toBe('package');
    expect(nodeOf(ex, 'method', 'com.acme.A.Abs.value').isAbstract).toBe(true);
    expect(nodeOf(ex, 'method', 'com.acme.A.run').isAbstract).toBeUndefined();
  });

  it('records extends, implements, decorates and overrides as unresolved refs', async () => {
    const ex = await extractFixture('Classes.java');
    const a = nodeOf(ex, 'class', 'com.acme.A');
    const run = nodeOf(ex, 'method', 'com.acme.A.run');
    expect(refNamed(ex, 'extends', 'B').fromNodeId).toBe(a.id);
    expect(refs(ex, 'implements').map((r) => r.referenceName)).toEqual(['C', 'Runnable']);
    const dec = refNamed(ex, 'decorates', 'Deprecated');
    expect(dec.fromNodeId).toBe(a.id);
    expect(refNamed(ex, 'decorates', 'Override').fromNodeId).toBe(run.id);
    const ov = refNamed(ex, 'overrides', 'run');
    expect(ov.fromNodeId).toBe(run.id);
    expect(ov).toMatchObject({
      filePath: 'src/Classes.java',
      language: 'java',
      status: 'pending',
      nameTail: 'run',
    });
  });

  it('keeps the textual receiver on calls and records instantiations', async () => {
    const ex = await extractFixture('Classes.java');
    const a = nodeOf(ex, 'class', 'com.acme.A');
    const run = nodeOf(ex, 'method', 'com.acme.A.run');
    const ctor = nodeOf(ex, 'method', 'com.acme.A.A');
    const callsFromRun = refs(ex, 'calls')
      .filter((r) => r.fromNodeId === run.id)
      .map((r) => r.referenceName);
    expect(callsFromRun).toEqual(['helper', 'this.helper', 'repo.save', 'Util.f', 'go']);
    expect(refNamed(ex, 'calls', 'helper').nameTail).toBe('helper');
    expect(refNamed(ex, 'calls', 'repo.save').nameTail).toBe('save');
    expect(refNamed(ex, 'calls', 'this.init').fromNodeId).toBe(ctor.id);
    expect(refNamed(ex, 'calls', 'compute').fromNodeId).toBe(a.id);
    expect(refNamed(ex, 'instantiates', 'Repo').fromNodeId).toBe(a.id);
    expect(refNamed(ex, 'instantiates', 'ArrayList').fromNodeId).toBe(run.id);
    expect(refNamed(ex, 'instantiates', 'com.acme.Thing').fromNodeId).toBe(run.id);
  });

  it('names inner classes Outer.Inner and skips local and anonymous classes', async () => {
    const ex = await extractFixture('Nesting.java');
    expect(ex.errors).toEqual([]);
    const outer = nodeOf(ex, 'class', 'com.acme.Outer');
    const inner = nodeOf(ex, 'class', 'com.acme.Outer.Inner');
    expect(hasContains(ex, outer, inner)).toBe(true);
    nodeOf(ex, 'class', 'com.acme.Outer.Inner.Deeper');
    nodeOf(ex, 'method', 'com.acme.Outer.Inner.Deeper.bottom');
    nodeOf(ex, 'class', 'com.acme.Outer.Nested');
    expect(names(ex, 'class')).toEqual([
      'com.acme.Outer',
      'com.acme.Outer.Inner',
      'com.acme.Outer.Inner.Deeper',
      'com.acme.Outer.Nested',
    ]);
    expect(names(ex, 'method').sort()).toEqual([
      'com.acme.Outer.Inner.Deeper.bottom',
      'com.acme.Outer.Inner.deep',
      'com.acme.Outer.work',
    ]);
    expect(names(ex, 'field')).toEqual([]);
  });

  it('attaches calls of local, anonymous and lambda code to the enclosing method', async () => {
    const ex = await extractFixture('Nesting.java');
    const work = nodeOf(ex, 'method', 'com.acme.Outer.work');
    const deep = nodeOf(ex, 'method', 'com.acme.Outer.Inner.deep');
    expect(refNamed(ex, 'calls', 'ping').fromNodeId).toBe(deep.id);
    for (const name of ['skipped', 'fromAnon', 'fromLambda', 'r.run']) {
      expect(refNamed(ex, 'calls', name).fromNodeId).toBe(work.id);
    }
    expect(refNamed(ex, 'instantiates', 'Runnable').fromNodeId).toBe(work.id);
  });

  it('extracts enums, interfaces, records and annotation types', async () => {
    const ex = await extractFixture('Types.java');
    expect(ex.errors).toEqual([]);
    const color = nodeOf(ex, 'enum', 'com.acme.Color');
    const red = nodeOf(ex, 'enum_member', 'com.acme.Color.RED');
    nodeOf(ex, 'enum_member', 'com.acme.Color.GREEN');
    expect(names(ex, 'enum_member')).toEqual(['com.acme.Color.RED', 'com.acme.Color.GREEN']);
    expect(hasContains(ex, color, red)).toBe(true);
    expect(refNamed(ex, 'implements', 'Named').fromNodeId).toBe(color.id);
    expect(nodeOf(ex, 'method', 'com.acme.Color.code').visibility).toBe('public');
    expect(names(ex, 'method').filter((n) => n === 'com.acme.Color.Color')).toHaveLength(2);
    expect(names(ex, 'method')).not.toContain('com.acme.Color.x');
    nodeOf(ex, 'field', 'com.acme.Color.n');

    const shape = nodeOf(ex, 'interface', 'com.acme.Shape');
    expect(shape.visibility).toBe('package');
    const shapeSupers = refs(ex, 'extends').filter((r) => r.fromNodeId === shape.id);
    expect(shapeSupers.map((r) => r.referenceName)).toEqual(['Named', 'Comparable']);
    const sides = nodeOf(ex, 'field', 'com.acme.Shape.SIDES');
    expect(sides.visibility).toBe('public');
    expect(sides.isStatic).toBe(true);
    const area = nodeOf(ex, 'method', 'com.acme.Shape.area');
    expect(area.isAbstract).toBe(true);
    expect(area.visibility).toBe('public');
    expect(nodeOf(ex, 'method', 'com.acme.Shape.label').isAbstract).toBeUndefined();
    expect(nodeOf(ex, 'method', 'com.acme.Shape.unit').isStatic).toBe(true);
    expect(nodeOf(ex, 'method', 'com.acme.Shape.unit').isAbstract).toBeUndefined();
    const hidden = nodeOf(ex, 'method', 'com.acme.Shape.hidden');
    expect(hidden.visibility).toBe('private');
    expect(hidden.isAbstract).toBeUndefined();

    const point = nodeOf(ex, 'class', 'com.acme.Point');
    expect(point.metadata).toEqual({ javaKind: 'record' });
    nodeOf(ex, 'method', 'com.acme.Point.sum');
    const compact = nodeOf(ex, 'method', 'com.acme.Point.Point');
    expect(compact.metadata).toEqual({ constructor: true });
    expect(refNamed(ex, 'calls', 'check').fromNodeId).toBe(compact.id);
    expect(nodeOf(ex, 'class', 'com.acme.Marker').metadata).toEqual({ javaKind: 'annotation' });
  });

  it('records imports with the full name, static and star metadata', async () => {
    const ex = await extractFixture('Imports.java');
    expect(ex.errors).toEqual([]);
    expect(refs(ex, 'imports').map((r) => [r.referenceName, r.metadata])).toEqual([
      ['java.util.List', { binding: 'List' }],
      ['java.util', { star: true }],
      ['org.x.Util.f', { static: true, binding: 'f' }],
      ['org.x.Util', { static: true, star: true }],
    ]);
    const file = required(ex.nodes.find((n) => n.kind === 'file'), 'file');
    expect(refs(ex, 'imports').every((r) => r.fromNodeId === file.id)).toBe(true);
    expect(refs(ex, 'imports')[0]?.nameTail).toBe('List');
    expect(names(ex, 'import')).toEqual(['java.util.List', 'java.util.*', 'org.x.Util.f', 'org.x.Util.*']);
  });

  it('keeps the valid nodes of a file with a syntax error and a consistent graph', async () => {
    const ex = await extractFixture('SyntaxError.java');
    expect(ex.errors.length).toBeGreaterThan(0);
    nodeOf(ex, 'class', 'com.acme.Fine');
    nodeOf(ex, 'method', 'com.acme.Fine.ok');
    nodeOf(ex, 'class', 'com.acme.Second');
    nodeOf(ex, 'method', 'com.acme.Second.m');
    const ids = new Set(ex.nodes.map((n) => n.id));
    for (const e of ex.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
    for (const u of ex.unresolved) expect(ids.has(u.fromNodeId)).toBe(true);
  });
});
