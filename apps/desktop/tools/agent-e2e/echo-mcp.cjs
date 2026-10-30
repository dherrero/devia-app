#!/usr/bin/env node
'use strict';
/**
 * A user MCP server for the harness: one tool, `echo_token`, returning a fixed
 * token. If an agent can quote the token, the user's MCP-manager server reached
 * it through Devia (S-30 T-356).
 */
const TOKEN = 'ECHO-7Q4Z';
let buf = '';
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.id === undefined) continue; // notification
    if (req.method === 'initialize') {
      send({ id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'e2e-echo', version: '1.0.0' } } });
    } else if (req.method === 'tools/list') {
      send({ id: req.id, result: { tools: [{ name: 'echo_token', description: 'Returns the harness token.', inputSchema: { type: 'object', properties: {} } }] } });
    } else if (req.method === 'tools/call') {
      send({ id: req.id, result: { content: [{ type: 'text', text: TOKEN }] } });
    } else {
      send({ id: req.id, error: { code: -32601, message: 'method not found' } });
    }
  }
});
