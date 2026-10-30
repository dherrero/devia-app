import { advertisedUiTools } from './tool-registry';
import { callUiTool, type UiToolDeps } from './ui-tools-call';

/**
 * JSON-RPC 2.0 dispatch for the `devia-ui` MCP server, split from the stdio
 * entry point so it can be driven directly in tests.
 */

export const SERVER_INFO = { name: 'devia-ui', version: '1.0.0' };
export const DEFAULT_PROTOCOL = '2025-06-18';

/**
 * One short paragraph, deliberately NOT one line per tool: the per-tool
 * guidance already lives in each schema description, and repeating it here
 * would pay for it twice in the cached prompt prefix.
 */
export const SERVER_INSTRUCTIONS =
  'You are connected to devia-ui, the desktop app the user is watching you work in. ' +
  'These tools draw real UI in that app: the blocking ones stop your turn until the user acts, ' +
  'so wait for the result instead of assuming one. ' +
  'Only the tools listed here reach this run — if the one you want is missing, ' +
  'do the same thing in plain text and end your turn.';

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type SendFn = (msg: object) => void;

export function createUiDispatcher(
  deps: UiToolDeps,
  send: SendFn,
): (msg: JsonRpcMessage) => Promise<void> {
  const respond = (id: JsonRpcMessage['id'], result: unknown): void =>
    send({ jsonrpc: '2.0', id, result });
  const fail = (id: JsonRpcMessage['id'], code: number, message: string): void =>
    send({ jsonrpc: '2.0', id, error: { code, message } });

  return async (msg: JsonRpcMessage): Promise<void> => {
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
        respond(id, { tools: advertisedUiTools(deps.advertised) });
        return;

      case 'tools/call': {
        const name = typeof params?.['name'] === 'string' ? (params['name'] as string) : '';
        try {
          const result = await callUiTool(deps, name, params?.['arguments']);
          respond(id, {
            content: [{ type: 'text', text: result.text }],
            ...(result.isError === true && { isError: true }),
          });
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
}
