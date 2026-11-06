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

const FIXTURES = path.join(__dirname, '..', '__fixtures__', 'python');

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

describe('pythonExtractor', () => {
  it('registers for python', () => {
    expect(extractorFor('python')?.language).toBe('python');
  });

  it('extracts the module, a class with methods, bases and dotted qualified names', async () => {
    const ex = await extractFixture('classes.py');
    expect(ex.errors).toEqual([]);
    const file = required(
      ex.nodes.find((n) => n.kind === 'file'),
      'file',
    );
    const mod = nodeOf(ex, 'module', 'src.classes');
    expect(hasContains(ex, file, mod)).toBe(true);
    expect(mod.docstring).toBe('Animal module docs.');

    const animal = nodeOf(ex, 'class', 'src.classes.Animal');
    expect(hasContains(ex, mod, animal)).toBe(true);
    expect(animal.docstring).toBe('An animal.\n\n    Lives in the zoo.');
    expect(animal.isExported).toBe(true);
    expect(animal.signature).toBe(
      'class Animal(Base, abc.ABC, metaclass=Meta):',
    );

    const init = nodeOf(ex, 'method', 'src.classes.Animal.__init__');
    expect(hasContains(ex, animal, init)).toBe(true);
    expect(init.visibility).toBe('public');
    expect(init.isAsync).toBeUndefined();
    const run = nodeOf(ex, 'method', 'src.classes.Animal.run');
    expect(run.isAsync).toBe(true);
    expect(nodeOf(ex, 'method', 'src.classes.Animal.create').isStatic).toBe(
      true,
    );
    expect(nodeOf(ex, 'method', 'src.classes.Animal._hidden').visibility).toBe(
      'private',
    );
    expect(nodeOf(ex, 'method', 'src.classes.Animal.__secret').visibility).toBe(
      'private',
    );
    nodeOf(ex, 'class', 'src.classes.Animal.Inner');
    nodeOf(ex, 'method', 'src.classes.Animal.Inner.go');
    expect(nodeOf(ex, 'function', 'src.classes.top').docstring).toBe(
      'Top docs.',
    );

    expect(refNamed(ex, 'extends', 'Base').fromNodeId).toBe(animal.id);
    expect(refNamed(ex, 'extends', 'abc.ABC').nameTail).toBe('ABC');
    expect(refs(ex, 'extends')).toHaveLength(2);
  });

  it('emits calls as textual callees from the enclosing symbol or the file', async () => {
    const ex = await extractFixture('classes.py');
    const run = nodeOf(ex, 'method', 'src.classes.Animal.run');
    expect(refNamed(ex, 'calls', 'self.helper').fromNodeId).toBe(run.id);
    expect(refNamed(ex, 'calls', 'other').fromNodeId).toBe(run.id);
    const create = nodeOf(ex, 'method', 'src.classes.Animal.create');
    const animalCall = refNamed(ex, 'calls', 'Animal');
    expect(animalCall.fromNodeId).toBe(create.id);
    expect(animalCall.line).toBe(20);
    expect(animalCall.language).toBe('python');
    expect(animalCall.status).toBe('pending');
    expect(refNamed(ex, 'calls', 'util.work').fromNodeId).toBe(
      nodeOf(ex, 'function', 'src.classes.top').id,
    );
    expect(refs(ex, 'instantiates')).toEqual([]);

    const fn = await extractFixture('functions.py');
    const file = required(
      fn.nodes.find((n) => n.kind === 'file'),
      'file',
    );
    expect(refNamed(fn, 'calls', 'setup').fromNodeId).toBe(file.id);
    expect(refNamed(fn, 'calls', 'main').fromNodeId).toBe(file.id);
  });

  it('emits one unresolved import per binding with relative levels preserved', async () => {
    const ex = await extractFixture('imports.py');
    expect(ex.errors).toEqual([]);
    const byName = (name: string): UnresolvedRef[] =>
      refs(ex, 'imports').filter((r) => r.referenceName === name);
    expect(byName('os')[0]?.metadata).toEqual({ binding: 'os' });
    expect(byName('a.b').map((r) => r.metadata)).toEqual([
      { binding: 'a' },
      { binding: 'c', alias: 'c' },
    ]);
    expect(byName('.utils')[0]?.metadata).toEqual({
      binding: 'helper',
      imported: 'helper',
    });
    expect(byName('.utils')[0]?.nameTail).toBe('utils');
    expect(byName('..')[0]?.metadata).toEqual({
      binding: 'parent_thing',
      imported: 'parent_thing',
    });
    expect(byName('..x').map((r) => r.metadata)).toEqual([
      { binding: 'z', imported: 'y', alias: 'z' },
      { binding: 'w', imported: 'w' },
    ]);
    expect(byName('m')[0]?.metadata).toMatchObject({ star: true });
    const file = required(
      ex.nodes.find((n) => n.kind === 'file'),
      'file',
    );
    expect(byName('os')[0]?.fromNodeId).toBe(file.id);
    expect(names(ex, 'import')).toContain('src.imports.os');
    expect(names(ex, 'import')).toContain('src.imports..utils');
  });

  it('hangs decorators off the decorated node', async () => {
    const ex = await extractFixture('functions.py');
    const handler = nodeOf(ex, 'function', 'src.functions.handler');
    expect(handler.decorators).toEqual(['app.route', 'functools.lru_cache']);
    expect(refNamed(ex, 'decorates', 'app.route').fromNodeId).toBe(handler.id);
    expect(refNamed(ex, 'decorates', 'functools.lru_cache').fromNodeId).toBe(
      handler.id,
    );
    expect(refs(ex, 'calls').some((r) => r.referenceName === 'app.route')).toBe(
      false,
    );
    expect(handler.signature).toBe('def handler(req):');
  });

  it('treats if/try/for at module level as module scope and ignores comprehensions', async () => {
    const ex = await extractFixture('functions.py');
    expect(ex.errors).toEqual([]);
    expect(nodeOf(ex, 'constant', 'src.functions.MAX_SIZE').isExported).toBe(
      true,
    );
    nodeOf(ex, 'variable', 'src.functions.counter');
    nodeOf(ex, 'function', 'src.functions.double');
    nodeOf(ex, 'function', 'src.functions.checked');
    nodeOf(ex, 'function', 'src.functions.fallback');
    nodeOf(ex, 'constant', 'src.functions.FALLBACK');
    nodeOf(ex, 'constant', 'src.functions.LOOP_CONST');
    const handler = nodeOf(ex, 'function', 'src.functions.handler');
    expect(refNamed(ex, 'calls', 'convert').fromNodeId).toBe(handler.id);
    expect(refNamed(ex, 'calls', 'deep').fromNodeId).toBe(
      nodeOf(ex, 'function', 'src.functions.handler.inner').id,
    );
  });

  it('does not turn nested declarations into module symbols', async () => {
    const ex = await extractFixture('nesting.py');
    nodeOf(ex, 'function', 'src.nesting.outer.inner');
    nodeOf(ex, 'class', 'src.nesting.outer.Local');
    expect(names(ex, 'function')).toEqual([
      'src.nesting.outer',
      'src.nesting.outer.inner',
    ]);
    expect(names(ex, 'variable')).toEqual([]);
  });

  it('honours __all__ and underscore visibility for exports', async () => {
    const ex = await extractFixture('exports.py');
    expect(nodeOf(ex, 'function', 'src.exports.public_a').isExported).toBe(
      true,
    );
    expect(
      nodeOf(ex, 'function', 'src.exports._private_but_listed').isExported,
    ).toBe(true);
    expect(nodeOf(ex, 'function', 'src.exports.not_listed').isExported).toBe(
      false,
    );

    const plain = await extractFixture('default_exports.py');
    expect(
      nodeOf(plain, 'function', 'src.default_exports.visible').isExported,
    ).toBe(true);
    expect(
      nodeOf(plain, 'function', 'src.default_exports._hidden').isExported,
    ).toBe(false);
    const mangled = nodeOf(plain, 'class', 'src.default_exports.__Mangled');
    expect(mangled.isExported).toBe(false);
    expect(mangled.visibility).toBe('private');
  });

  it('derives the module path from the file path', async () => {
    const pkg = await extractSource(
      'pkg/sub/__init__.py',
      'def f():\n    pass\n',
    );
    nodeOf(pkg, 'module', 'pkg.sub');
    nodeOf(pkg, 'function', 'pkg.sub.f');
    const flat = await extractSource('tool.py', 'X = 1\n');
    nodeOf(flat, 'module', 'tool');
    nodeOf(flat, 'constant', 'tool.X');
  });

  it('keeps the valid nodes of a file with a syntax error', async () => {
    const ex = await extractFixture('syntax_error.py');
    expect(ex.errors.length).toBeGreaterThan(0);
    nodeOf(ex, 'function', 'src.syntax_error.good');
    nodeOf(ex, 'class', 'src.syntax_error.Fine');
    nodeOf(ex, 'method', 'src.syntax_error.Fine.m');
  });
});
