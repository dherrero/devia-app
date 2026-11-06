import { describe, expect, it } from 'vitest';
import { ExtractionBuilder, headerText, nameTail, unquote, walk } from './extractor';
import { createParser } from './grammars';
import { makeNodeId } from './node-id';

describe('extractor text helpers', () => {
  it('takes the last segment of a dotted name', () => {
    expect(nameTail('util.greet')).toBe('greet');
    expect(nameTail('this.a.b')).toBe('b');
    expect(nameTail('foo')).toBe('foo');
    expect(nameTail('./m')).toBe('./m');
    expect(nameTail('../lib/x')).toBe('../lib/x');
  });

  it('strips quotes', () => {
    expect(unquote("'./m'")).toBe('./m');
    expect(unquote('"x"')).toBe('x');
    expect(unquote('`t`')).toBe('t');
    expect(unquote('bare')).toBe('bare');
  });
});

describe('ExtractionBuilder', () => {
  it('builds scoped symbols, contains edges, refs and syntax errors', async () => {
    const parser = await createParser('python');
    const source = 'class A:\n    def m(self):\n        pass\n\ndef f(:\n';
    const tree = parser.parse(source);
    if (!tree) throw new Error('no tree');
    try {
      const b = new ExtractionBuilder('pkg/a.py', 'python', tree.rootNode);
      expect(b.file.id).toBe(makeNodeId('pkg/a.py', 'file', 'pkg/a.py', 1));
      expect(b.file.name).toBe('a.py');

      const cls = required(tree.rootNode.namedChild(0));
      const method = required(cls.childForFieldName('body')?.namedChild(0));
      const a = b.addSymbol({ kind: 'class', name: 'A', syntax: cls }, b.scopeAt(cls));
      b.enterScope(cls, a);
      expect(b.scopeAt(method).node).toBe(a);
      const m = b.addSymbol(
        { kind: 'method', name: 'm', syntax: method, signature: headerText(source, method, method.childForFieldName('body')) },
        b.scopeAt(method),
      );
      expect(m.qualifiedName).toBe('A.m');
      expect(m.signature).toBe('def m(self):');
      expect(b.addSymbol({ kind: 'method', name: 'm', syntax: method }, b.scopeAt(method))).toBe(m);
      b.addRef(m.id, 'self.x.run', 'calls', method, { via: 'test' });

      const after = required(tree.rootNode.namedChild(1));
      expect(b.scopeAt(after).node).toBe(b.file);

      let errorSeen = false;
      walk(tree.rootNode, (n) => {
        if (b.noteSyntaxError(n)) errorSeen = true;
      });
      expect(errorSeen).toBe(true);

      const out = b.result;
      expect(out.nodes.map((n) => n.qualifiedName)).toEqual(['pkg/a.py', 'A', 'A.m']);
      expect(out.edges).toEqual([
        { source: b.file.id, target: a.id, kind: 'contains', provenance: 'static' },
        { source: a.id, target: m.id, kind: 'contains', provenance: 'static' },
      ]);
      expect(out.unresolved).toEqual([
        {
          fromNodeId: m.id,
          referenceName: 'self.x.run',
          referenceKind: 'calls',
          line: 2,
          col: 4,
          filePath: 'pkg/a.py',
          language: 'python',
          status: 'pending',
          nameTail: 'run',
          metadata: { via: 'test' },
        },
      ]);
      expect(out.errors[0]).toMatch(/^pkg\/a\.py:5:\d+ (syntax error|missing)/);
    } finally {
      tree.delete();
      parser.delete();
    }
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing node');
  return value;
}
