// Adapted from codegraph (MIT) — see NOTICE
// Upstream codegraph: src/extraction/grammars.ts (extension map and wasm loading).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Language, Parser } from 'web-tree-sitter';
import type { CodeGraphLanguage } from '../../../../../shared/domain/code-graph';

export const EXTENSION_MAP: Readonly<Record<string, CodeGraphLanguage>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyw': 'python',
  '.java': 'java',
  '.go': 'go',
  '.dart': 'dart',
};

function extensionOf(relPath: string): string {
  const base = relPath.slice(Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot).toLowerCase();
}

export function languageForPath(relPath: string): CodeGraphLanguage | undefined {
  return EXTENSION_MAP[extensionOf(relPath)];
}

export function grammarVariantForPath(relPath: string): 'tsx' | undefined {
  const ext = extensionOf(relPath);
  return ext === '.tsx' || ext === '.jsx' ? 'tsx' : undefined;
}

const WASM_FILES: Readonly<Record<CodeGraphLanguage, string>> = {
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
  go: 'tree-sitter-go.wasm',
  dart: 'tree-sitter-dart.wasm',
};
const TSX_WASM = 'tree-sitter-tsx.wasm';
const SOURCE_WASM_SUBPATH = path.join(
  'src',
  'main',
  'features',
  'code-graph',
  'engine',
  'extraction',
  'wasm',
);

function hasWasm(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.wasm'));
  } catch {
    return false;
  }
}

function findPackageRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (pkg.name === 'devia-app') return dir;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// watch:main and dev never run copy-assets, so dist/ may lack the wasm files; fall back to the sources.
export function resolveWasmDir(from: string = __dirname): string {
  const beside = path.join(from, 'wasm');
  if (hasWasm(beside)) return beside;
  const root = findPackageRoot(from);
  return root ? path.join(root, SOURCE_WASM_SUBPATH) : beside;
}

let wasmDirOverride: string | undefined;

export function setWasmDirForTests(dir: string | undefined): void {
  wasmDirOverride = dir;
  languageCache.clear();
}

let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language>>();

function ensureInit(): Promise<void> {
  initPromise ??= Parser.init().catch((err: unknown) => {
    initPromise = undefined;
    throw err;
  });
  return initPromise;
}

export function loadGrammar(lang: CodeGraphLanguage, variant?: 'tsx'): Promise<Language> {
  const file = variant === 'tsx' && (lang === 'typescript' || lang === 'javascript') ? TSX_WASM : WASM_FILES[lang];
  const cached = languageCache.get(file);
  if (cached) return cached;
  const dir = wasmDirOverride ?? resolveWasmDir();
  const loading = ensureInit()
    .then(async () => Language.load(new Uint8Array(await fs.promises.readFile(path.join(dir, file)))))
    .catch((err: unknown) => {
      languageCache.delete(file);
      throw err;
    });
  languageCache.set(file, loading);
  return loading;
}

// Languages are immutable and safe to cache; a Tree is not: never share one across worker threads,
// and the caller must tree.delete() it, since wasm memory is not garbage collected.
export async function createParser(lang: CodeGraphLanguage, variant?: 'tsx'): Promise<Parser> {
  const language = await loadGrammar(lang, variant);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
