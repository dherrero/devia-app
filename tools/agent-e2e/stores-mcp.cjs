#!/usr/bin/env node
'use strict';
/**
 * Two user MCP servers in one file for the `codemode` scenario (S-50), picked by
 * the STORES_ROLE env var: `tiendas` (which stores are in a region) and `ventas`
 * (what a store sold). The data is fixed so the right answer is checkable:
 *   norte -> T1, T2, T3;  sales: T1 = 100, T2 = 900, T3 = 300  =>  T2 / 900.
 * `borrar_tienda` has no readOnlyHint, so a script that calls it must be denied.
 */
const ROLE = process.env.STORES_ROLE || 'tiendas';
const REGIONS = { norte: ['T1', 'T2', 'T3'], sur: ['T4'] };
const SALES = { T1: 100, T2: 900, T3: 300, T4: 50 };

const TOOLS = {
  tiendas: [
    {
      name: 'listar_por_region',
      description: 'Ids of the stores of a region.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] },
    },
    {
      name: 'borrar_tienda',
      description: 'Deletes a store.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  ],
  ventas: [
    {
      name: 'ventas_de_tienda',
      description: 'Total sales of a store.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  ],
}[ROLE];

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function call(name, args) {
  if (name === 'listar_por_region') return text((REGIONS[args.region] || []).map((id) => ({ id })));
  if (name === 'ventas_de_tienda') return text({ id: args.id, total: SALES[args.id] ?? 0 });
  if (name === 'borrar_tienda') return text({ deleted: args.id });
  return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.id === undefined) continue;
    if (req.method === 'initialize') {
      send({ id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `e2e-${ROLE}`, version: '1.0.0' } } });
    } else if (req.method === 'tools/list') {
      send({ id: req.id, result: { tools: TOOLS } });
    } else if (req.method === 'tools/call') {
      send({ id: req.id, result: call(req.params.name, req.params.arguments || {}) });
    } else {
      send({ id: req.id, error: { code: -32601, message: 'method not found' } });
    }
  }
});
