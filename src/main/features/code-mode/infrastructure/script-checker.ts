import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

import { TS_LIBS_ENTRY } from './ts-libs';

/**
 * Compile-time gate for `run_script` (S-50). The script is type-checked against
 * the declarations generated from the real MCP schemas BEFORE it runs, so a
 * misspelled argument costs the agent a cheap diagnostic instead of a real call.
 * Nothing here executes the script or touches a server.
 */

export interface ScriptDiagnostic {
  line: number;
  column: number;
  message: string;
}

export type CheckResult = { ok: true; js: string } | { ok: false; diagnostics: ScriptDiagnostic[] };

// The agent writes a function BODY (top-level `await` and `return`). It is wrapped
// on the SAME first line, so line N of the script stays line N in a diagnostic.
const PREFIX = 'async function __devia_main() {';
const SUFFIX = '\n}';
const SCRIPT_FILE = '/__devia/script.ts';
const TOOLS_FILE = '/__devia/tools.d.ts';
const SHIM_FILE = '/__devia/shim.d.ts';
// The sandbox has `console.log` and nothing else: no DOM lib, no @types/node.
const SHIM = 'declare const console: { log(...args: unknown[]): void };';

const LIB_DIR = '/__devia/lib';

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  lib: [TS_LIBS_ENTRY],
  types: [],
  noEmit: true,
  strict: true,
  // Results of servers without an outputSchema are `any`; an implicit-any
  // callback parameter should not be a reason to reject an otherwise fine script.
  noImplicitAny: false,
  // `catch (e) { e.message }` is how every script handles a failed tool call.
  useUnknownInCatchVariables: false,
  skipLibCheck: true,
};

// The standard library files are parsed once per process, not once per script.
const diskLibCache = new Map<string, ts.SourceFile>();
// Per set of bundled libs, so two different sets never share a parsed file.
const bundledLibCaches = new WeakMap<object, Map<string, ts.SourceFile>>();
function libCacheFor(libs: Libs | null): Map<string, ts.SourceFile> {
  if (libs === null) return diskLibCache;
  let cache = bundledLibCaches.get(libs);
  if (!cache) bundledLibCaches.set(libs, (cache = new Map()));
  return cache;
}

type Libs = Readonly<Record<string, string>>;

/** The libs `scripts/copy-assets.cjs` bundled next to this file, or null (dev, tests). */
let bundled: Libs | null | undefined;
function bundledLibs(): Libs | null {
  if (bundled === undefined) {
    try {
      bundled = JSON.parse(fs.readFileSync(path.join(__dirname, 'ts-libs.json'), 'utf8')) as Libs;
    } catch {
      bundled = null;
    }
  }
  return bundled;
}

/**
 * With `libs`, the compiler is served ONLY the script, the declarations and those
 * libs: nothing is read from disk, which is what makes the installed app work.
 * Without them it falls back to the typescript package's own files.
 */
function createHost(virtualFiles: ReadonlyMap<string, string>, libs: Libs | null): ts.CompilerHost {
  const host = ts.createCompilerHost(OPTIONS, true);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const libCache = libCacheFor(libs);
  const libText = (f: string): string | undefined =>
    libs !== null && f.startsWith(`${LIB_DIR}/`) ? libs[f.slice(LIB_DIR.length + 1)] : undefined;
  if (libs !== null) {
    host.getDefaultLibLocation = () => LIB_DIR;
    host.directoryExists = (d) => d === '/__devia' || d === LIB_DIR;
    host.getDirectories = () => [];
  }
  host.fileExists = (f) => virtualFiles.has(f) || libText(f) !== undefined || (libs === null && baseFileExists(f));
  host.readFile = (f) => virtualFiles.get(f) ?? libText(f) ?? (libs === null ? baseReadFile(f) : undefined);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const virtual = virtualFiles.get(fileName);
    if (virtual !== undefined) return ts.createSourceFile(fileName, virtual, languageVersion, true);
    const cached = libCache.get(fileName);
    if (cached) return cached;
    const text = libText(fileName);
    const sf = text !== undefined
      ? ts.createSourceFile(fileName, text, languageVersion, true)
      : libs === null ? baseGetSourceFile(fileName, languageVersion, onError, shouldCreate) : undefined;
    if (sf) libCache.set(fileName, sf);
    return sf;
  };
  return host;
}

export function checkScript(code: string, declarations: string): CheckResult {
  return checkScriptWith(code, declarations, bundledLibs());
}

export function checkScriptWith(code: string, declarations: string, libs: Libs | null): CheckResult {
  const wrapped = `${PREFIX}${code}${SUFFIX}`;
  const files = new Map<string, string>([
    [SCRIPT_FILE, wrapped],
    [TOOLS_FILE, declarations],
    [SHIM_FILE, SHIM],
  ]);
  const program = ts.createProgram([SCRIPT_FILE, TOOLS_FILE, SHIM_FILE], OPTIONS, createHost(files, libs));
  const sf = program.getSourceFile(SCRIPT_FILE);
  if (!sf) return { ok: false, diagnostics: [{ line: 1, column: 1, message: 'The script could not be parsed.' }] };

  const syntactic = program.getSyntacticDiagnostics(sf);
  const found = syntactic.length > 0 ? syntactic : program.getSemanticDiagnostics(sf);
  if (found.length > 0) {
    return {
      ok: false,
      diagnostics: found.map((d) => {
        const pos = sf.getLineAndCharacterOfPosition(d.start ?? 0);
        return {
          line: pos.line + 1,
          column: Math.max(1, pos.character + 1 - (pos.line === 0 ? PREFIX.length : 0)),
          message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        };
      }),
    };
  }

  const out = ts.transpileModule(wrapped, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: false },
    reportDiagnostics: false,
  }).outputText;
  const open = /__devia_main\(\)\s*\{/.exec(out);
  const close = out.lastIndexOf('}');
  if (!open || close < open.index) {
    return { ok: false, diagnostics: [{ line: 1, column: 1, message: 'The script could not be compiled.' }] };
  }
  return { ok: true, js: out.slice(open.index + open[0].length, close) };
}
