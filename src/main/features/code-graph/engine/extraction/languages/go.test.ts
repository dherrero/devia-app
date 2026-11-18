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

const FIXTURES = path.join(__dirname, '..', '__fixtures__', 'go');

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

describe('goExtractor', () => {
  it('registers for go', () => {
    expect(extractorFor('go')?.language).toBe('go');
  });

  it('extracts the package, structs, fields and embedded types', async () => {
    const ex = await extractFixture('types.go');
    expect(ex.errors).toEqual([]);
    const file = required(
      ex.nodes.find((n) => n.kind === 'file'),
      'file',
    );
    const pkg = nodeOf(ex, 'namespace', 'shapes');
    expect(hasContains(ex, file, pkg)).toBe(true);
    expect(pkg.docstring).toBe('Package shapes holds shapes.');

    const s = nodeOf(ex, 'class', 'S');
    expect(s.metadata).toEqual({ goKind: 'struct' });
    expect(s.docstring).toBe('S is a struct.\nIt runs.');
    expect(s.isExported).toBe(true);
    expect(s.visibility).toBe('public');
    expect(hasContains(ex, file, s)).toBe(true);

    const n = nodeOf(ex, 'field', 'S.n');
    expect(hasContains(ex, s, n)).toBe(true);
    expect(n.isExported).toBe(false);
    expect(n.visibility).toBe('private');
    expect(nodeOf(ex, 'field', 'S.Name').isExported).toBe(true);
    nodeOf(ex, 'field', 'S.Label');
    nodeOf(ex, 'field', 'S.inner');
    expect(ex.nodes.some((x) => x.qualifiedName === 'S.inner.x')).toBe(false);

    // `type`: the receiver type fact (T-515); pointers are transparent, `int` is no project type.
    const embeddedTypes: Record<string, string> = { Base: 'Base', Other: 'Other', Remote: 'pkg.Remote', Stack: 'Stack<?>' };
    for (const [name, type] of Object.entries(embeddedTypes)) {
      expect(nodeOf(ex, 'field', `S.${name}`).metadata).toEqual({
        embedded: true,
        type,
      });
    }
    const ext = refs(ex, 'extends').filter((r) => r.fromNodeId === s.id);
    expect(ext.map((r) => r.referenceName)).toEqual([
      'Base',
      'Other',
      'pkg.Remote',
      'Stack',
    ]);
    for (const r of ext) expect(r.metadata).toEqual({ embedded: true });
    expect(refNamed(ex, 'extends', 'pkg.Remote').nameTail).toBe('Remote');
  });

  it('extracts interfaces with methods and embedded interfaces', async () => {
    const ex = await extractFixture('types.go');
    const runner = nodeOf(ex, 'interface', 'Runner');
    expect(runner.docstring).toBe('Runner runs.');
    const run = nodeOf(ex, 'method', 'Runner.Run');
    nodeOf(ex, 'method', 'Runner.Stop');
    expect(hasContains(ex, runner, run)).toBe(true);
    const ext = refs(ex, 'extends').filter((r) => r.fromNodeId === runner.id);
    expect(ext.map((r) => r.referenceName)).toEqual(['io.Closer', 'Walker']);
    for (const r of ext) expect(r.metadata).toEqual({ embedded: true });
    expect(
      ex.nodes.filter(
        (n) => n.kind === 'method' && n.qualifiedName.startsWith('Runner.'),
      ),
    ).toHaveLength(2);
  });

  it('models other named types as type_alias and ignores type parameters', async () => {
    const ex = await extractFixture('types.go');
    expect(names(ex, 'type_alias').sort()).toEqual(['A', 'F', 'ID']);
    nodeOf(ex, 'class', 'Stack');
    nodeOf(ex, 'method', 'Stack.Push');
    expect(ex.nodes.some((n) => n.qualifiedName.includes('['))).toBe(false);
  });

  it('attaches methods to their receiver type with pointer-ness', async () => {
    const ex = await extractFixture('types.go');
    const file = required(
      ex.nodes.find((n) => n.kind === 'file'),
      'file',
    );
    const s = nodeOf(ex, 'class', 'S');
    const run = nodeOf(ex, 'method', 'S.Run');
    expect(hasContains(ex, s, run)).toBe(true);
    expect(run.metadata).toEqual({ pointerReceiver: true });
    expect(run.isExported).toBe(true);
    const stop = nodeOf(ex, 'method', 'S.Stop');
    expect(stop.metadata).toBeUndefined();
    expect(hasContains(ex, s, stop)).toBe(true);
    expect(
      hasContains(
        ex,
        nodeOf(ex, 'class', 'Stack'),
        nodeOf(ex, 'method', 'Stack.Push'),
      ),
    ).toBe(true);

    const ping = nodeOf(ex, 'method', 'Remote.Ping');
    expect(hasContains(ex, file, ping)).toBe(true);
    expect(ping.metadata).toEqual({ pointerReceiver: true });
  });

  it('marks exported identifiers by their first rune', async () => {
    const ex = await extractFixture('types.go');
    const exported = nodeOf(ex, 'function', 'Exported');
    expect(exported.isExported).toBe(true);
    expect(exported.visibility).toBe('public');
    expect(exported.docstring).toBe('Exported is exported.');
    const internal = nodeOf(ex, 'function', 'internal');
    expect(internal.isExported).toBe(false);
    expect(internal.visibility).toBe('private');
  });

  it('emits calls with textual callees from the enclosing symbol', async () => {
    const ex = await extractFixture('types.go');
    const run = nodeOf(ex, 'method', 'S.Run');
    const calls = refs(ex, 'calls').filter((r) => r.fromNodeId === run.id);
    expect(calls.map((r) => r.referenceName)).toEqual([
      'helper',
      's.Stop',
      'fmt.Println',
    ]);
    const helper = refNamed(ex, 'calls', 'helper');
    expect(helper).toMatchObject({
      filePath: 'src/types.go',
      language: 'go',
      status: 'pending',
      nameTail: 'helper',
    });
    expect(refNamed(ex, 'calls', 'fmt.Println').nameTail).toBe('Println');
  });

  it('attaches closure calls to the enclosing function and never makes closures or locals symbols', async () => {
    const ex = await extractFixture('types.go');
    const build = nodeOf(ex, 'function', 'Build');
    expect(refNamed(ex, 'calls', 'worker').fromNodeId).toBe(build.id);
    expect(
      ex.nodes.some((n) => ['local', 'c', 'localT'].includes(n.name)),
    ).toBe(false);
    expect(names(ex, 'variable')).toEqual([]);
    expect(names(ex, 'constant')).toEqual([]);
  });

  it('emits instantiates for composite literals', async () => {
    const ex = await extractFixture('types.go');
    const build = nodeOf(ex, 'function', 'Build');
    const inst = refs(ex, 'instantiates');
    expect(inst.map((r) => r.referenceName)).toEqual([
      'S',
      'Base',
      'pkg.Remote',
      'pkg.Remote',
      'Stack',
    ]);
    for (const r of inst) expect(r.fromNodeId).toBe(build.id);
    expect(inst[2]?.nameTail).toBe('Remote');
  });

  it('extracts imports with alias, blank and dot metadata', async () => {
    const ex = await extractFixture('imports.go');
    expect(ex.errors).toEqual([]);
    const file = required(
      ex.nodes.find((n) => n.kind === 'file'),
      'file',
    );
    const imps = refs(ex, 'imports');
    expect(imps.map((r) => r.referenceName)).toEqual([
      'fmt',
      'x/y/mathx',
      'x/y/drivers',
      'x/y/dots',
      'x/y/plain',
      'x/y/v2',
    ]);
    for (const r of imps) expect(r.fromNodeId).toBe(file.id);
    expect(imps[0]?.metadata).toEqual({ binding: 'fmt' });
    expect(imps[1]?.metadata).toEqual({ alias: 'm', binding: 'm' });
    expect(imps[2]?.metadata).toEqual({ blank: true, binding: '_' });
    expect(imps[3]?.metadata).toEqual({ dot: true, binding: '.' });
    expect(imps[4]?.metadata).toEqual({ binding: 'plain' });
    expect(imps[5]?.metadata).toEqual({ binding: 'v2' });
    expect(names(ex, 'import')).toHaveLength(6);
    const imp = nodeOf(ex, 'import', 'x/y/mathx');
    expect(hasContains(ex, file, imp)).toBe(true);
    expect(imp.signature).toBe('m "x/y/mathx"');
    const call = refNamed(ex, 'calls', 'plain.New');
    expect(call.fromNodeId).toBe(file.id);
  });

  it('extracts package-level constants and variables only', async () => {
    const ex = await extractFixture('vars.go');
    expect(ex.errors).toEqual([]);
    const file = required(
      ex.nodes.find((n) => n.kind === 'file'),
      'file',
    );
    expect(names(ex, 'constant')).toEqual(['Pi', 'A', 'b', 'C']);
    expect(names(ex, 'variable')).toEqual(['Global', 'x', 'Y', 'z']);
    const pi = nodeOf(ex, 'constant', 'Pi');
    expect(pi.isExported).toBe(true);
    expect(hasContains(ex, file, pi)).toBe(true);
    expect(nodeOf(ex, 'constant', 'b').isExported).toBe(false);
    expect(nodeOf(ex, 'variable', 'x').visibility).toBe('private');
    expect(nodeOf(ex, 'variable', 'Y').visibility).toBe('public');
    expect(refNamed(ex, 'calls', 'compute').fromNodeId).toBe(file.id);
    expect(refNamed(ex, 'calls', 'register').fromNodeId).toBe(file.id);
    expect(refNamed(ex, 'instantiates', 'Config').fromNodeId).toBe(file.id);
  });

  it('extracts generated files like any other', async () => {
    const ex = await extractFixture('generated.go');
    expect(ex.errors).toEqual([]);
    nodeOf(ex, 'namespace', 'pb');
    nodeOf(ex, 'class', 'Msg');
    nodeOf(ex, 'field', 'Msg.ID');
    nodeOf(ex, 'method', 'Msg.Reset');
  });

  it('never infers implements', async () => {
    const ex = await extractFixture('types.go');
    expect(refs(ex, 'implements')).toEqual([]);
    expect(ex.edges.some((e) => e.kind === 'implements')).toBe(false);
  });

  it('keeps the valid nodes of a file with a syntax error and a consistent graph', async () => {
    const ex = await extractFixture('syntax_error.go');
    expect(ex.errors.length).toBeGreaterThan(0);
    nodeOf(ex, 'class', 'Fine');
    nodeOf(ex, 'method', 'Fine.Ok');
    nodeOf(ex, 'class', 'Second');
    nodeOf(ex, 'method', 'Second.M');
    const ids = new Set(ex.nodes.map((n) => n.id));
    expect(ids.size).toBe(ex.nodes.length);
    for (const e of ex.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
    for (const u of ex.unresolved) expect(ids.has(u.fromNodeId)).toBe(true);
  });

  it('does not throw on an empty file', async () => {
    const ex = await extractSource('src/empty.go', '');
    expect(ex.nodes).toHaveLength(1);
  });
});
