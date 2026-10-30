import * as readline from 'node:readline';

import { KanbanUseCase } from '../kanban/application/kanban.use-case';
import { KanbanStore } from '../kanban/infrastructure/kanban-store';
import { advertisedKanbanTools, callKanbanTool } from './kanban-tools';

/**
 * devia-kanban — standalone MCP server (E-DSK-12 T5).
 *
 * Spawned by the active CLI agent (its MCP client) over stdio. Speaks
 * minimal JSON-RPC 2.0 with newline-delimited framing (the MCP stdio
 * transport) — no SDK dependency. It reads/writes the same per-project
 * `kanban.json` the app uses; the app's KanbanWatcher reflects every
 * mutation back into the UI.
 *
 * Invocation (baked into the injected MCP config, per project):
 *   node <...>/server.js --devia-dir <~/.devia-app> --project <absProjectPath>
 *
 * Cross-process consistency: the in-memory cache is invalidated before
 * every tool call so the server always reads the latest on-disk board.
 * Reads are reserved for stdout; diagnostics go to stderr.
 */

const SERVER_INFO = { name: 'devia-kanban', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

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
    process.stderr.write('[devia-kanban] missing --devia-dir or --project\n');
    process.exit(2);
    return;
  }

  const store = new KanbanStore(() => deviaDir);
  // No hooks: this process only mutates the file. The app watches it.
  const useCase = new KanbanUseCase(store);

  const send = (msg: object): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const respond = (id: JsonRpcMessage['id'], result: unknown): void =>
    send({ jsonrpc: '2.0', id, result });
  const fail = (id: JsonRpcMessage['id'], code: number, message: string): void =>
    send({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = (msg: JsonRpcMessage): void => {
    const { id, method, params } = msg;
    if (!method) return; // a response/ack to one of our messages — ignore

    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion:
            typeof params?.['protocolVersion'] === 'string'
              ? params['protocolVersion']
              : DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
        return;

      case 'notifications/initialized':
      case 'initialized':
        return; // notification — no reply

      case 'ping':
        respond(id, {});
        return;

      case 'tools/list': {
        // S-16 T-188: on an empty board, advertise only the bootstrap tools so
        // a project that never uses the kanban does not pay the full ~13-tool
        // surface in the cached prompt prefix every turn.
        store.invalidate(project);
        const board = store.load(project);
        const empty = board.specs.length === 0 && board.tasks.length === 0;
        respond(id, { tools: advertisedKanbanTools(empty) });
        return;
      }

      case 'tools/call': {
        const name = typeof params?.['name'] === 'string' ? (params['name'] as string) : '';
        const args = params?.['arguments'];
        store.invalidate(project); // always operate on the freshest board
        try {
          const text = callKanbanTool({ useCase, store, projectPath: project }, name, args);
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
    handle(msg);
  });
  rl.on('close', () => process.exit(0));
}

main();
