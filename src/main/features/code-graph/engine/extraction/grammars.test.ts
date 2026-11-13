import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createParser,
  grammarVariantForPath,
  languageForPath,
  loadGrammar,
  resolveWasmDir,
  setWasmDirForTests,
} from './grammars';
import { CODE_GRAPH_LANGUAGES, type CodeGraphLanguage } from '../../../../../shared/domain/code-graph';
import { extractorFor, registerExtractor } from './registry';
import { lineOf, nodeText, findChildByType, walk, type LanguageExtractor } from './extractor';
import { makeNodeId } from './node-id';

afterEach(() => setWasmDirForTests(undefined));

describe('languageForPath', () => {
  it('maps extensions', () => {
    expect(languageForPath('lib/main.dart')).toBe('dart');
    expect(languageForPath('a/b.d.ts')).toBe('typescript');
    expect(languageForPath('a/b.tsx')).toBe('typescript');
    expect(languageForPath('a/b.mjs')).toBe('javascript');
    expect(languageForPath('a\\b.PY')).toBe('python');
    expect(languageForPath('x.rb')).toBeUndefined();
    expect(languageForPath('Makefile')).toBeUndefined();
  });

  it('picks the tsx variant only for tsx/jsx', () => {
    expect(grammarVariantForPath('a.tsx')).toBe('tsx');
    expect(grammarVariantForPath('a.jsx')).toBe('tsx');
    expect(grammarVariantForPath('a.ts')).toBeUndefined();
    expect(grammarVariantForPath('a.js')).toBeUndefined();
  });
});

describe('loadGrammar', () => {
  it('parses python', async () => {
    const parser = await createParser('python');
    const tree = parser.parse('def f(): pass')!;
    expect(tree.rootNode.hasError).toBe(false);
    tree.delete();
    parser.delete();
  });

  it('caches Language objects', async () => {
    expect(await loadGrammar('go')).toBe(await loadGrammar('go'));
  });

  it('loads every grammar and the tsx variant', async () => {
    for (const lang of ['typescript', 'javascript', 'python', 'java', 'go', 'dart'] as const) {
      expect(await loadGrammar(lang)).toBeDefined();
    }
    const parser = await createParser('typescript', 'tsx');
    const tree = parser.parse('const a = <div/>;')!;
    expect(tree.rootNode.hasError).toBe(false);
    tree.delete();
  });

  it('honours the wasmDir override', async () => {
    setWasmDirForTests(path.join(os.tmpdir(), 'devia-no-such-wasm-dir'));
    await expect(loadGrammar('python')).rejects.toThrow();
  });

  it('falls back to the source wasm dir when dist has none', () => {
    const dir = resolveWasmDir(path.join(__dirname, '..', 'db'));
    expect(dir).toBe(path.join(__dirname, 'wasm'));
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.wasm'))).toBe(true);
  });
});

describe('makeNodeId', () => {
  it('is deterministic and sensitive to inputs', () => {
    const a = makeNodeId('src/a.ts', 'function', 'f', 3);
    expect(makeNodeId('src/a.ts', 'function', 'f', 3)).toBe(a);
    expect(makeNodeId('src/a.ts', 'function', 'f', 4)).not.toBe(a);
    expect(makeNodeId('src/a.ts', 'method', 'f', 3)).not.toBe(a);
    expect(makeNodeId('src\\a.ts', 'function', 'f', 3)).toBe(a);
  });
});

describe('registry', () => {
  it('registers and returns extractors', () => {
    const e: LanguageExtractor = {
      language: 'go',
      extensions: ['.go'],
      extract: () => ({ nodes: [], edges: [], unresolved: [], errors: [] }),
    };
    registerExtractor(e);
    expect(extractorFor('go')).toBe(e);
    expect(extractorFor('dart')?.language).toBe('dart');
  });

  it('has an extractor for every supported language and none for an unregistered key', () => {
    for (const lang of CODE_GRAPH_LANGUAGES) expect(extractorFor(lang)?.language).toBe(lang);
    expect(extractorFor('ruby' as CodeGraphLanguage)).toBeUndefined();
  });
});

describe('extractor helpers', () => {
  it('walks iteratively, skips subtrees and reads text', async () => {
    const parser = await createParser('python');
    const source = 'def f():\n    x = 1\n\ndef g(): pass\n';
    const tree = parser.parse(source)!;
    const names: string[] = [];
    let visited = 0;
    walk(tree.rootNode, (n) => {
      visited++;
      if (n.type === 'function_definition') {
        names.push(nodeText(source, findChildByType(n, 'identifier')!) + '@' + lineOf(n));
        return false;
      }
      return true;
    });
    expect(names).toEqual(['f@1', 'g@4']);
    expect(visited).toBeLessThan(10);
    tree.delete();
  });
});
