import { describe, expect, it } from 'vitest';

import { generateDeclarations } from '../domain/declarations';
import type { CatalogTool } from '../domain/tool-catalog';
import { checkScript } from './script-checker';

const TOOLS: CatalogTool[] = [
  {
    server: 'tiendas',
    name: 'listar',
    inputSchema: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] },
    outputSchema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    readOnly: true,
  },
  {
    server: 'ventas',
    name: 'consultar',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    readOnly: true,
  },
];
const DECLS = generateDeclarations(TOOLS);

describe('checkScript', () => {
  it('accepts a valid script and returns JS without type annotations', () => {
    const r = checkScript(
      [
        "const stores = await tools.tiendas.listar({ region: 'norte' });",
        'const ids: string[] = stores.map((s) => s.id);',
        'return ids as string[];',
      ].join('\n'),
      DECLS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.js).not.toContain('string[]');
      expect(r.js).toContain('tools.tiendas.listar');
      expect(r.js).toContain('return ids');
      expect(r.js).not.toContain('__devia_main');
    }
  });

  it('rejects an argument with the wrong name, on the right line', () => {
    const r = checkScript("const a = 1;\nawait tools.tiendas.listar({ zona: 'x' });", DECLS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]?.line).toBe(2);
      expect(r.diagnostics[0]?.message).toMatch(/zona|region/);
    }
  });

  it('rejects ambient capabilities the sandbox does not have', () => {
    for (const code of ['return process.env.HOME;', "return await fetch('x');", "return require('fs');"]) {
      const r = checkScript(code, DECLS);
      expect(r.ok, code).toBe(false);
    }
    const r = checkScript('return process.env.HOME;', DECLS);
    if (!r.ok) expect(r.diagnostics[0]?.message).toContain("Cannot find name 'process'");
  });

  it('accepts top-level await and return', () => {
    expect(checkScript('const x = await Promise.resolve(1);\nreturn x;', DECLS).ok).toBe(true);
  });

  it('lets a result without outputSchema be used without a cast', () => {
    const r = checkScript("const v = await tools.ventas.consultar({ id: 'a' });\nreturn v.total + v.items.length;", DECLS);
    expect(r.ok).toBe(true);
  });

  it('allows console.log', () => {
    expect(checkScript("console.log('x', 1);\nreturn 1;", DECLS).ok).toBe(true);
  });

  it('reports a syntax error with its line', () => {
    const r = checkScript('const a = 1;\nconst = ;', DECLS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]?.line).toBe(2);
  });

  it('does not shift the line of an error on the first line', () => {
    const r = checkScript('return process.env;', DECLS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]).toMatchObject({ line: 1, column: 8 });
  });
});
