import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import { callGraphTool, createGraphToolContext, GRAPH_TOOLS, isGraphTool } from './graph-tools';
import { SERVER_INSTRUCTIONS } from './server-instructions';

/**
 * devia-code-graph — standalone MCP server (S-44), spawned by the agent's CLI over stdio.
 * Newline-delimited JSON-RPC 2.0, no SDK, same transport as devia-memory. Bound to one
 * project: `node <...>/server.js --devia-dir <~/.devia-app> --project <absProjectPath>`.
 * stdout carries only protocol messages; diagnostics go to stderr.
 */

const SERVER_INFO = { name: 'devia-code-graph', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';
const LOG_PREFIX = '[devia-code-graph]';

type JsonRpcId = number | string | null;

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function parseArgs(argv: string[]): { deviaDir: string; project: string } {
  let deviaDir = '';
  let project = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--devia-dir') deviaDir = argv[++i] ?? '';
    else if (argv[i] === '--project') project = argv[++i] ?? '';
  }
  return { deviaDir, project };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function validId(id: unknown): id is JsonRpcId {
  return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

function main(): void {
  const log = (line: string): void => {
    process.stderr.write(`${LOG_PREFIX} ${line}\n`);
  };
  const { deviaDir, project } = parseArgs(process.argv.slice(2));
  if (!deviaDir || !project) {
    log('missing --devia-dir or --project');
    process.exit(2);
    return;
  }
  if (!path.isAbsolute(project) || !isDirectory(project)) {
    log(`--project must be an existing absolute directory: ${project}`);
    process.exit(2);
    return;
  }

  const ctx = createGraphToolContext({ deviaDir, project, log: (line) => process.stderr.write(`${line}\n`) });

  const send = (msg: object): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const respond = (id: JsonRpcId, result: unknown): void => send({ jsonrpc: '2.0', id, result });
  const fail = (id: JsonRpcId, code: number, message: string): void =>
    send({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = async (msg: JsonRpcMessage): Promise<void> => {
    const isRequest = 'id' in msg && msg.id !== undefined;
    if (msg.method === undefined) {
      // A response to us (we send no requests) is ignored; anything else is malformed.
      if (isRequest && !('result' in msg) && !('error' in msg)) fail(validId(msg.id) ? msg.id : null, -32600, 'Invalid Request');
      return;
    }
    if (typeof msg.method !== 'string' || (isRequest && !validId(msg.id))) {
      if (isRequest) fail(validId(msg.id) ? msg.id : null, -32600, 'Invalid Request');
      return;
    }
    const method = msg.method;
    const params = typeof msg.params === 'object' && msg.params !== null ? (msg.params as Record<string, unknown>) : undefined;
    if (!isRequest) return; // notification — never answered
    const id = msg.id as JsonRpcId;

    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion:
            typeof params?.['protocolVersion'] === 'string' ? params['protocolVersion'] : DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        });
        return;

      case 'ping':
        respond(id, {});
        return;

      case 'tools/list':
        respond(id, { tools: GRAPH_TOOLS });
        return;

      case 'tools/call': {
        const name = typeof params?.['name'] === 'string' ? params['name'] : '';
        if (!isGraphTool(name)) {
          fail(id, -32602, `Unknown tool: ${name || '(missing name)'}`);
          return;
        }
        respond(id, await callGraphTool(ctx, name, params?.['arguments']));
        return;
      }

      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  };

  const pending = new Set<Promise<void>>();
  const track = (msg: JsonRpcMessage): void => {
    const p = handle(msg)
      .catch((err: unknown) => {
        log(`request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        if (validId(msg.id) && msg.id !== null) fail(msg.id, -32603, 'Internal error');
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  };

  let exiting = false;
  const exit = (code: number): void => {
    if (exiting) return;
    exiting = true;
    // A broken stdout may never call back; do not hang on it.
    setTimeout(() => process.exit(code), 1000).unref();
    process.stdout.write('', () => process.exit(code));
  };

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      fail(null, -32700, 'Parse error');
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      fail(null, -32600, 'Invalid Request');
      return;
    }
    track(msg as JsonRpcMessage);
  });
  // Answer whatever is still in flight (a piped batch closes stdin right after writing).
  rl.on('close', () => {
    void Promise.allSettled([...pending]).then(() => exit(0));
  });

  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    log(`stdout error: ${err.message}`);
  });
  process.on('SIGTERM', () => exit(0));
  process.on('SIGINT', () => exit(0));
  process.on('uncaughtException', (err) => log(`uncaught: ${err.stack ?? err.message}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${String(err)}`));
}

main();
