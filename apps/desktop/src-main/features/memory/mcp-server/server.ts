import * as readline from 'node:readline';

import { MemoryStore } from '../infrastructure/memory-store';
import { MemoryUseCase } from '../application/memory.use-case';
import { MEMORY_TOOLS, callMemoryTool } from './memory-tools';

/**
 * devia-memory — standalone MCP server (Fase 2, T-8).
 *
 * Spawned by the active CLI agent (its MCP client) over stdio. Speaks
 * minimal JSON-RPC 2.0 with newline-delimited framing (the MCP stdio
 * transport) — no SDK dependency. It reads/writes the same per-project
 * `memory.json` the app uses.
 *
 * Invocation (baked into the injected MCP config, per project):
 *   node <...>/server.js --devia-dir <~/.devia-app> --project <absProjectPath>
 *
 * Cross-process consistency: the in-memory cache is invalidated before
 * every tool call so the server always reads the latest on-disk document.
 * Reads are reserved for stdout; diagnostics go to stderr.
 */

const SERVER_INFO = { name: 'devia-memory', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

/**
 * Brief instructions injected in the MCP `initialize` response.
 *
 * Goal: the agent reads these once and understands the Memory Protocol
 * without relying on an external system prompt. Kept short on purpose.
 */
const SERVER_INSTRUCTIONS =
  'You are connected to devia-memory. ' +
  'Save decisions, bugs, and discoveries proactively with mem_save — do not wait to be asked. ' +
  'Search prior context with mem_search before starting work. ' +
  'Always close the session with mem_session_summary before saying "done".';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
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

function main(): void {
  const { deviaDir, project } = parseArgs(process.argv.slice(2));
  if (!deviaDir || !project) {
    process.stderr.write('[devia-memory] missing --devia-dir or --project\n');
    process.exit(2);
    return;
  }

  const store = new MemoryStore(() => deviaDir);
  const useCase = new MemoryUseCase(store);
  // S-2 F1.1: the runner injects the active agent id at spawn time so every
  // record written through this server knows which agent authored it.
  const agentId = process.env['DEVIA_ACTIVE_AGENT_ID'];

  const send = (msg: object): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const respond = (id: JsonRpcMessage['id'], result: unknown): void =>
    send({ jsonrpc: '2.0', id, result });
  const fail = (id: JsonRpcMessage['id'], code: number, message: string): void =>
    send({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = async (msg: JsonRpcMessage): Promise<void> => {
    const { id, method, params } = msg;
    if (!method) return; // a response/ack — ignore

    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion:
            typeof params?.['protocolVersion'] === 'string'
              ? params['protocolVersion']
              : DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        });
        return;

      case 'notifications/initialized':
      case 'initialized':
        return; // notification — no reply

      case 'ping':
        respond(id, {});
        return;

      case 'tools/list':
        respond(id, { tools: MEMORY_TOOLS });
        return;

      case 'tools/call': {
        const name = typeof params?.['name'] === 'string' ? (params['name'] as string) : '';
        const args = params?.['arguments'];
        // Invalidate the cache before every tool call so the server
        // always operates on the freshest on-disk document (another
        // process — or the Devia UI — may have written since the last call).
        store.invalidate('project', project);
        try {
          const text = await callMemoryTool(
            { useCase, store, projectPath: project, ...(agentId !== undefined && agentId !== '' && { agentId }) },
            name,
            args,
          );
          respond(id, { content: [{ type: 'text', text }] });
        } catch (err) {
          respond(id, {
            content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
            isError: true,
          });
        }
        return;
      }

      default:
        if (id !== undefined && id !== null) fail(id, -32601, `Method not found: ${method}`);
    }
  };

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return; // malformed line — skip
    }
    void handle(msg);
  });
  rl.on('close', () => process.exit(0));
}

main();
