#!/usr/bin/env node
/* Minimal stdio MCP server for the code-mode tests. Newline-delimited JSON-RPC 2.0.
 * FAKE_NAME tags every answer so a test can tell two servers apart. */
const readline = require('node:readline');

const NAME = process.env.FAKE_NAME || 'fake';

const PAGE_1 = [
  {
    name: 'echo',
    description: 'Returns its arguments',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  },
  { name: 'text_json', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
  { name: 'text_plain', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
];
const PAGE_2 = [
  { name: 'write_thing', description: 'No annotations at all', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
  { name: 'rpc_error', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'die', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
  { name: 'env_keys', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

function callTool(id, name, args) {
  switch (name) {
    case 'echo':
      return reply(id, { content: [{ type: 'text', text: 'ignored' }], structuredContent: { echo: args, server: NAME } });
    case 'text_json':
      return reply(id, { content: [{ type: 'text', text: '{"a":1}' }] });
    case 'text_plain':
      return reply(id, { content: [{ type: 'text', text: 'hello' }] });
    case 'write_thing':
      return reply(id, { content: [{ type: 'text', text: '"written"' }] });
    case 'fail':
      return reply(id, { isError: true, content: [{ type: 'text', text: 'boom from server' }] });
    case 'rpc_error':
      return fail(id, -32000, 'rpc exploded');
    case 'slow':
      return void setTimeout(() => reply(id, { content: [{ type: 'text', text: '"late"' }] }), Number(args && args.ms) || 0);
    case 'die':
      return process.exit(1);
    case 'env_keys':
      return reply(id, { content: [{ type: 'text', text: 'ignored' }], structuredContent: Object.keys(process.env) });
    default:
      return fail(id, -32601, `unknown tool ${name}`);
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notification
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: `fake-${NAME}`, version: '1.0.0' },
      });
    case 'tools/list':
      return msg.params && msg.params.cursor === 'p2'
        ? reply(msg.id, { tools: PAGE_2 })
        : reply(msg.id, { tools: PAGE_1, nextCursor: 'p2' });
    case 'tools/call':
      return callTool(msg.id, msg.params.name, msg.params.arguments);
    default:
      return fail(msg.id, -32601, `unknown method ${msg.method}`);
  }
});
