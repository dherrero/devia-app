import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import type { McpServerConfig } from '../../../../shared/domain/mcp';
import type { BridgePolicy } from '../application/bridge';
import type { ToolAccess } from '../domain/tool-catalog';
import { McpClientPool } from '../infrastructure/mcp-client-pool';
import { CodeModeGateway, DEFAULT_LIMITS, DEFAULT_POLICY_BUDGETS } from './code-mode-tools';
import { buildServerInstructions } from './server-instructions';

/**
 * devia-code-mode — standalone MCP server (S-50), spawned by the agent's CLI over
 * stdio, same transport and shape as devia-code-graph: newline-delimited JSON-RPC
 * 2.0, no SDK, stdout carries only protocol messages, diagnostics go to stderr.
 *
 *   node server.js --servers-file <abs.json> [--events-dir <abs>]
 *
 * The servers file is `{ servers: McpServerConfig[], writeOverrides?: {...} }`: the
 * MCP servers that live behind the gateway. `DEVIA_CODE_MODE_MODE` carries the run
 * mode (plan | apply | apply-yolo). The child servers and their credentials stay in
 * THIS process; the sandbox only ever sees the `tools` proxy.
 */

const SERVER_INFO = { name: 'devia-code-mode', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';
const LOG_PREFIX = '[devia-code-mode]';

type JsonRpcId = number | string | null;

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface ServersFile {
  servers: McpServerConfig[];
  writeOverrides?: Record<string, ToolAccess>;
}

function parseArgs(argv: string[]): { serversFile: string; eventsDir: string | null } {
  let serversFile = '';
  let eventsDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--servers-file') serversFile = argv[++i] ?? '';
    else if (argv[i] === '--events-dir') eventsDir = argv[++i] ?? null;
  }
  return { serversFile, eventsDir };
}

function validId(id: unknown): id is JsonRpcId {
  return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

function readServersFile(file: string): ServersFile {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ServersFile>;
  if (!Array.isArray(parsed.servers)) throw new Error('servers file has no "servers" array');
  return { servers: parsed.servers, ...(parsed.writeOverrides && { writeOverrides: parsed.writeOverrides }) };
}

function runMode(): BridgePolicy['mode'] {
  const raw = process.env['DEVIA_CODE_MODE_MODE'];
  return raw === 'plan' || raw === 'apply-yolo' ? raw : 'apply';
}

function main(): void {
  const log = (line: string): void => {
    process.stderr.write(`${LOG_PREFIX} ${line}\n`);
  };
  const args = parseArgs(process.argv.slice(2));
  if (!args.serversFile || !path.isAbsolute(args.serversFile)) {
    log('--servers-file must be an absolute path');
    process.exit(2);
    return;
  }
  let file: ServersFile;
  try {
    file = readServersFile(args.serversFile);
  } catch (err: unknown) {
    log(`cannot read the servers file: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
    return;
  }
  const eventsDir = args.eventsDir ?? process.env['DEVIA_CODE_MODE_EVENTS_DIR'] ?? null;

  const instructions = buildServerInstructions(file.servers);
  const gateway = new CodeModeGateway({
    servers: file.servers,
    pool: new McpClientPool(file.servers, process.env),
    policy: {
      mode: runMode(),
      ...DEFAULT_POLICY_BUDGETS,
      ...(file.writeOverrides && { writeOverrides: file.writeOverrides }),
    },
    limits: DEFAULT_LIMITS,
    eventsDir,
  });

  const send = (msg: object): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const respond = (id: JsonRpcId, result: unknown): void => send({ jsonrpc: '2.0', id, result });
  const fail = (id: JsonRpcId, code: number, message: string): void =>
    send({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = async (msg: JsonRpcMessage): Promise<void> => {
    const isRequest = 'id' in msg && msg.id !== undefined;
    if (msg.method === undefined) {
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
          instructions,
        });
        return;

      case 'ping':
        respond(id, {});
        return;

      case 'tools/list':
        respond(id, { tools: gateway.definitions() });
        return;

      case 'tools/call': {
        const name = typeof params?.['name'] === 'string' ? params['name'] : '';
        if (!gateway.definitions().some((d) => d.name === name)) {
          fail(id, -32602, `Unknown tool: ${name || '(missing name)'}`);
          return;
        }
        const result = await gateway.call(name, params?.['arguments']);
        respond(id, { content: [{ type: 'text', text: result.text }], ...(result.isError && { isError: true }) });
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
    // The MCP children must not outlive the gateway.
    setTimeout(() => process.exit(code), 3000).unref();
    void gateway
      .close()
      .catch(() => undefined)
      .finally(() => process.stdout.write('', () => process.exit(code)));
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
  rl.on('close', () => {
    void Promise.allSettled([...pending]).then(() => exit(0));
  });

  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') exit(0);
    log(`stdout error: ${err.message}`);
  });
  process.on('SIGTERM', () => exit(0));
  process.on('SIGINT', () => exit(0));
  process.on('uncaughtException', (err) => log(`uncaught: ${err.stack ?? err.message}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${String(err)}`));
}

main();
