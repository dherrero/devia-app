import { describe, expect, it } from 'vitest';

import { generateDeclarations } from './declarations';
import type { CatalogTool } from './tool-catalog';

function tool(partial: Partial<CatalogTool> & Pick<CatalogTool, 'server' | 'name'>): CatalogTool {
  return { inputSchema: { type: 'object', properties: {} }, readOnly: true, ...partial };
}

describe('generateDeclarations', () => {
  it('emits a required string field without a question mark', () => {
    const out = generateDeclarations([
      tool({
        server: 'tiendas',
        name: 'listar',
        inputSchema: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] },
      }),
    ]);
    expect(out).toContain('declare const tools');
    expect(out).toContain('tiendas');
    expect(out).toMatch(/listar\(args: \{[^}]*region: string;?[^}]*\}\)/);
    expect(out).not.toContain('region?:');
  });

  it('marks optional fields with a question mark', () => {
    const out = generateDeclarations([
      tool({
        server: 's',
        name: 't',
        inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
      }),
    ]);
    expect(out).toContain('limit?: number');
  });

  it('renders enums as a union of literals', () => {
    const out = generateDeclarations([
      tool({
        server: 's',
        name: 't',
        inputSchema: { type: 'object', properties: { kind: { enum: ['a', 'b'] } }, required: ['kind'] },
      }),
    ]);
    expect(out).toContain("kind: 'a' | 'b'");
  });

  it('returns Promise<any> when there is no output schema, so the script can use the result', () => {
    const out = generateDeclarations([tool({ server: 's', name: 't' })]);
    expect(out).toContain('Promise<any>');
    expect(out).not.toContain('Promise<unknown>');
  });

  it('types the result when an output schema exists', () => {
    const out = generateDeclarations([
      tool({
        server: 's',
        name: 't',
        outputSchema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      }),
    ]);
    expect(out).toMatch(/Promise<\{[^}]*id: string[^}]*\}\[\]>/);
  });

  it('sanitises server and tool names into valid identifiers', () => {
    const out = generateDeclarations([tool({ server: 'mi-server.x', name: '1-do it' })]);
    expect(out).toContain('mi_server_x');
    expect(out).toContain('_1_do_it');
  });

  it('falls back to unknown for unsupported schema shapes', () => {
    const out = generateDeclarations([
      tool({ server: 's', name: 't', inputSchema: { type: 'object', properties: { x: { oneOf: [] } }, required: ['x'] } }),
    ]);
    expect(out).toContain('x: unknown');
  });
});
