import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateDeclarations } from '../domain/declarations';
import { checkScriptWith } from './script-checker';
import { collectTsLibs, readTypescriptLib } from './ts-libs';

describe('collectTsLibs', () => {
  const files: Record<string, string> = {
    'lib.entry.d.ts': '/// <reference lib="es2021" />\n/// <reference lib="es2022.array" />\ndeclare const a: 1;',
    'lib.es2021.d.ts': '/// <reference lib="es2020" />\ndeclare const b: 1;',
    'lib.es2020.d.ts': 'declare const c: 1;',
    'lib.es2022.array.d.ts': '/// <reference lib="es2020" />\ndeclare const d: 1;',
  };
  const read = (name: string): string | undefined => files[name];

  it('gathers the entry and every file it references, each once', () => {
    const libs = collectTsLibs(read, 'lib.entry.d.ts');
    expect(Object.keys(libs).sort()).toEqual(['lib.entry.d.ts', 'lib.es2020.d.ts', 'lib.es2021.d.ts', 'lib.es2022.array.d.ts']);
  });

  it('fails loudly when a referenced file is missing, so a broken package never ships', () => {
    expect(() => collectTsLibs((n) => (n === 'lib.entry.d.ts' ? files[n] : undefined), 'lib.entry.d.ts')).toThrow(/TypeScript lib file not found: lib\.es20\d+/);
  });
});

describe('the bundled libs are enough to type-check a script, with no file on disk', () => {
  const libDir = path.dirname(require.resolve('typescript/lib/typescript.js'));
  const libs = collectTsLibs(readTypescriptLib(libDir));
  const decls = generateDeclarations([
    { server: 'tiendas', name: 'listar', inputSchema: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] }, readOnly: true },
  ]);

  it('ships the basic types: Promise, Array, Map, JSON', () => {
    expect(Object.keys(libs)).toEqual(expect.arrayContaining(['lib.es5.d.ts', 'lib.es2015.promise.d.ts', 'lib.es2022.d.ts']));
  });

  it('accepts a valid script', () => {
    const r = checkScriptWith("const m = new Map<string, number>();\nconst r = await tools.tiendas.listar({ region: 'x' });\nreturn JSON.stringify([r, [...m]]);", decls, libs);
    expect(r.ok).toBe(true);
  });

  it('still rejects what is not there', () => {
    const r = checkScriptWith('return process.env.HOME;', decls, libs);
    expect(r.ok).toBe(false);
  });

  it('takes the standard library from the bundle, not from the typescript package', () => {
    // A marker that exists only in the bundle: the script sees it only if the bundle was read.
    const marked = { ...libs, 'lib.es2022.d.ts': `${libs['lib.es2022.d.ts']}\ndeclare const ONLY_IN_THE_BUNDLE: number;` };
    expect(checkScriptWith('return ONLY_IN_THE_BUNDLE;', decls, marked).ok).toBe(true);
    expect(checkScriptWith('return ONLY_IN_THE_BUNDLE;', decls, libs).ok).toBe(false);
  });
});
