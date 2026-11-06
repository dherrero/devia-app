import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EdgeKind, GraphNode, NodeKind } from '../../../../../../shared/domain/code-graph';
import type { UnresolvedRef } from '../../db/queries';
import type { FileExtraction } from '../extractor';
import { createParser, grammarVariantForPath, languageForPath } from '../grammars';
import { makeNodeId } from '../node-id';
import { extractorFor } from '../registry';

const FIXTURES = path.join(__dirname, '..', '__fixtures__', 'ts');

function required<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

async function extractSource(relPath: string, source: string): Promise<FileExtraction> {
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
  return extractSource(`src/${name}`, fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function nodeOf(ex: FileExtraction, kind: NodeKind, qualifiedName: string): GraphNode {
  const found = ex.nodes.filter((n) => n.kind === kind && n.qualifiedName === qualifiedName);
  if (found.length !== 1) {
    const seen = ex.nodes.map((n) => `${n.kind}:${n.qualifiedName}`).join(', ');
    throw new Error(`expected one ${kind} ${qualifiedName}, got ${found.length} (${seen})`);
  }
  return required(found[0], qualifiedName);
}

function fileNode(ex: FileExtraction): GraphNode {
  return required(
    ex.nodes.find((n) => n.kind === 'file'),
    'file node',
  );
}

function refs(ex: FileExtraction, kind: EdgeKind): UnresolvedRef[] {
  return ex.unresolved.filter((u) => u.referenceKind === kind);
}

function refNamed(ex: FileExtraction, kind: EdgeKind, name: string): UnresolvedRef {
  return required(
    refs(ex, kind).find((u) => u.referenceName === name),
    `${kind} ref ${name}`,
  );
}

function hasContains(ex: FileExtraction, parent: GraphNode, child: GraphNode): boolean {
  return ex.edges.some((e) => e.kind === 'contains' && e.source === parent.id && e.target === child.id);
}

describe('typescriptExtractor', () => {
  it('registers for typescript and javascript', () => {
    expect(extractorFor('typescript')?.language).toBe('typescript');
    expect(extractorFor('javascript')?.language).toBe('javascript');
  });

  it('extracts a class with two methods, an extends and scoped names', async () => {
    const ex = await extractFixture('classes.ts');
    expect(ex.errors).toEqual([]);
    const file = fileNode(ex);
    expect(file.filePath).toBe('src/classes.ts');
    expect(file.id).toBe(makeNodeId('src/classes.ts', 'file', 'src/classes.ts', 1));

    const animal = nodeOf(ex, 'class', 'Animal');
    expect(animal.isExported).toBe(true);
    expect(animal.docstring).toBe('An animal that speaks.');
    expect(animal.signature).toBe('class Animal extends Base implements Speaker');
    expect(animal.startLine).toBe(4);
    expect(animal.endLine).toBe(15);
    expect(animal.id).toBe(makeNodeId('src/classes.ts', 'class', 'Animal', 4));

    const speak = nodeOf(ex, 'method', 'Animal.speak');
    const sound = nodeOf(ex, 'method', 'Animal.sound');
    expect(speak.name).toBe('speak');
    expect(speak.signature).toBe('speak(): string');
    expect(sound.isAsync).toBe(true);
    expect(ex.nodes.filter((n) => n.kind === 'method')).toHaveLength(2);
    expect(nodeOf(ex, 'property', 'Animal.count').isStatic).toBe(true);
    expect(nodeOf(ex, 'property', 'Animal.name').visibility).toBe('private');

    expect(hasContains(ex, file, animal)).toBe(true);
    expect(hasContains(ex, animal, speak)).toBe(true);
    expect(hasContains(ex, animal, sound)).toBe(true);

    const ext = refNamed(ex, 'extends', 'Base');
    expect(ext).toMatchObject({
      fromNodeId: animal.id,
      line: 4,
      filePath: 'src/classes.ts',
      language: 'typescript',
      status: 'pending',
      nameTail: 'Base',
    });
    expect(refNamed(ex, 'implements', 'Speaker').fromNodeId).toBe(animal.id);

    expect(refNamed(ex, 'calls', 'this.sound')).toMatchObject({
      fromNodeId: speak.id,
      line: 9,
      nameTail: 'sound',
    });
    expect(refNamed(ex, 'calls', 'util.greet')).toMatchObject({ fromNodeId: sound.id, nameTail: 'greet' });
    expect(refNamed(ex, 'instantiates', 'Voice').fromNodeId).toBe(sound.id);
  });

  it('extracts exported functions, arrow functions, variables and their calls', async () => {
    const ex = await extractFixture('functions.ts');
    const a = nodeOf(ex, 'function', 'a');
    expect(a.isExported).toBe(true);
    expect(a.signature).toBe('function a()');
    expect(refNamed(ex, 'calls', 'b')).toMatchObject({ fromNodeId: a.id, line: 2, col: 2, nameTail: 'b' });

    const f = nodeOf(ex, 'function', 'f');
    expect(f.isExported).toBe(false);
    expect(f.startLine).toBe(5);

    expect(nodeOf(ex, 'constant', 'LIMIT').isExported).toBe(true);
    expect(nodeOf(ex, 'variable', 'counter').isExported).toBe(false);
    expect(refNamed(ex, 'calls', 'init').fromNodeId).toBe(fileNode(ex).id);
  });

  it('emits one imports entry per binding with metadata', async () => {
    const ex = await extractFixture('imports.ts');
    const file = fileNode(ex);
    const imports = refs(ex, 'imports');
    expect(imports.every((u) => u.fromNodeId === file.id)).toBe(true);

    expect(refNamed(ex, 'imports', './m')).toMatchObject({
      line: 1,
      nameTail: './m',
      metadata: { binding: 'x', imported: 'x' },
    });
    const multi = imports.filter((u) => u.referenceName === './multi').map((u) => u.metadata);
    expect(multi).toEqual([
      { binding: 'y', imported: 'y' },
      { binding: 'w', imported: 'z', alias: 'w' },
    ]);
    expect(refNamed(ex, 'imports', './def').metadata).toEqual({ binding: 'Def', imported: 'default' });
    expect(refNamed(ex, 'imports', './ns').metadata).toEqual({ binding: 'ns', imported: '*', star: true });
    expect(refNamed(ex, 'imports', './types').metadata).toEqual({
      binding: 'T',
      imported: 'T',
      typeOnly: true,
    });
    expect(refNamed(ex, 'imports', './side-effect').metadata).toEqual({ sideEffect: true });
    expect(imports).toHaveLength(7);
    expect(ex.nodes.filter((n) => n.kind === 'import').map((n) => n.name)).toEqual([
      './m',
      './multi',
      './def',
      './ns',
      './types',
      './side-effect',
    ]);
  });

  it('treats CommonJS require like an import and parses .js with the javascript grammar', async () => {
    const ex = await extractFixture('commonjs.js');
    expect(ex.errors).toEqual([]);
    expect(fileNode(ex).language).toBe('javascript');
    expect(refNamed(ex, 'imports', './r').metadata).toEqual({
      binding: 'r',
      imported: '*',
      star: true,
      commonjs: true,
    });
    const ab = refs(ex, 'imports')
      .filter((u) => u.referenceName === './ab')
      .map((u) => u.metadata);
    expect(ab).toEqual([
      { binding: 'a', imported: 'a', commonjs: true },
      { binding: 'c', imported: 'b', alias: 'c', commonjs: true },
    ]);
    expect(refNamed(ex, 'imports', './side').metadata).toEqual({ sideEffect: true, commonjs: true });
    expect(refs(ex, 'calls').map((u) => u.referenceName)).not.toContain('require');
    expect(ex.nodes.some((n) => n.kind === 'variable' || n.kind === 'constant')).toBe(false);

    const dog = nodeOf(ex, 'class', 'Dog');
    expect(dog.language).toBe('javascript');
    expect(nodeOf(ex, 'method', 'Dog.bark').language).toBe('javascript');
    expect(nodeOf(ex, 'property', 'Dog.legs').signature).toBe('legs = 4');
    expect(refNamed(ex, 'extends', 'Animal').fromNodeId).toBe(dog.id);
  });

  it('marks an export default class as exported', async () => {
    const ex = await extractFixture('default-export.ts');
    const foo = nodeOf(ex, 'class', 'Foo');
    expect(foo.isExported).toBe(true);
    expect(foo.metadata).toEqual({ exportDefault: true });
    expect(nodeOf(ex, 'method', 'Foo.run').isExported).toBe(false);
  });

  it('extracts components and JSX references from .tsx', async () => {
    const ex = await extractFixture('component.tsx');
    expect(ex.errors).toEqual([]);
    const app = nodeOf(ex, 'component', 'App');
    expect(app.isExported).toBe(true);
    expect(nodeOf(ex, 'function', 'helper').kind).toBe('function');
    expect(refNamed(ex, 'references', 'Foo')).toMatchObject({ fromNodeId: app.id, line: 6 });
    expect(refs(ex, 'references').map((u) => u.referenceName)).toEqual(['Foo']);
  });

  it('keeps the valid nodes of a file with a syntax error', async () => {
    const ex = await extractFixture('syntax-error.ts');
    expect(ex.errors.length).toBeGreaterThan(0);
    expect(ex.errors[0]).toContain('src/syntax-error.ts:9');
    expect(nodeOf(ex, 'function', 'ok').isExported).toBe(true);
    nodeOf(ex, 'class', 'K');
    nodeOf(ex, 'method', 'K.m');
  });

  it('extracts interfaces, type aliases, enums, namespaces, decorators and exports', async () => {
    const ex = await extractFixture('declarations.ts');
    expect(ex.errors).toEqual([]);
    const shape = nodeOf(ex, 'interface', 'Shape');
    expect(shape.isExported).toBe(true);
    nodeOf(ex, 'method', 'Shape.area');
    nodeOf(ex, 'property', 'Shape.name');
    expect(refNamed(ex, 'extends', 'Base').fromNodeId).toBe(shape.id);

    expect(nodeOf(ex, 'type_alias', 'Id').signature).toBe('type Id = string;');
    const color = nodeOf(ex, 'enum', 'Color');
    expect(hasContains(ex, color, nodeOf(ex, 'enum_member', 'Color.Red'))).toBe(true);
    nodeOf(ex, 'enum_member', 'Color.Green');

    const geometry = nodeOf(ex, 'namespace', 'Geometry');
    const area = nodeOf(ex, 'function', 'Geometry.area');
    expect(hasContains(ex, geometry, area)).toBe(true);

    const widget = nodeOf(ex, 'class', 'Widget');
    expect(widget.decorators).toEqual(['Component']);
    const label = nodeOf(ex, 'property', 'Widget.label');
    expect(label.decorators).toEqual(['Input']);
    expect(label.signature).toBe("label = ''");
    const onClick = nodeOf(ex, 'method', 'Widget.onClick');
    expect(onClick.decorators).toEqual(['HostListener']);
    expect(refNamed(ex, 'decorates', 'Component').fromNodeId).toBe(widget.id);
    expect(refNamed(ex, 'decorates', 'HostListener').fromNodeId).toBe(onClick.id);
    expect(refs(ex, 'calls')).toEqual([]);

    expect(nodeOf(ex, 'constant', 'hidden').isExported).toBe(true);
    expect(nodeOf(ex, 'export', 'visible').metadata).toEqual({ local: 'hidden' });
    expect(refNamed(ex, 'imports', './barrel').metadata).toEqual({
      imported: '*',
      star: true,
      reexport: true,
    });
  });

  it('never throws on garbage input', async () => {
    const ex = await extractSource('src/junk.ts', '}{ class ( => @@ import from ;;; <<>>');
    expect(ex.errors.length).toBeGreaterThan(0);
    expect(fileNode(ex).kind).toBe('file');
  });
});
