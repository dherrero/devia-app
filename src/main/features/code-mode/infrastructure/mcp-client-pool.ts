import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { composeServerEnv } from '../../mcp/infrastructure/temp-config-writer';
import { classifyTool, type CatalogTool } from '../domain/tool-catalog';

/**
 * Stdio MCP clients for the servers a run puts behind code mode (S-50). One child
 * per server, newline-delimited JSON-RPC 2.0, no SDK (same transport as Devia's
 * own servers). The pool lives inside the gateway process, so the credentials a
 * server needs never reach the sandbox: they stay in `env` of that server's child.
 */

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 45_000;
const KILL_GRACE_MS = 1_000;

/** The little a child needs to run at all (`npx`, `uvx`, a locale). Everything else
 *  comes from the server's own `env` and its `allowedEnvKeys`. */
const BASE_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
  'SystemRoot', 'ComSpec', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles',
];

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  detach?: () => void;
}

class StdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private dead: Error | null = null;

  constructor(readonly serverId: string, private readonly config: McpServerConfig, private readonly env: Record<string, string>) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get isAlive(): boolean {
    return this.dead === null && this.child !== null;
  }

  async start(timeoutMs: number): Promise<void> {
    const child = spawn(this.config.command, this.config.args, {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.on('data', () => undefined); // drained so the child never blocks on a full pipe
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => this.fail(new Error(`MCP server "${this.serverId}" could not start: ${err.message}`)));
    child.on('exit', (code, signal) =>
      this.fail(new Error(`MCP server "${this.serverId}" exited (${signal ?? `code ${code ?? '?'}`})`)),
    );

    await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'devia-code-mode', version: '1.0.0' },
      },
      timeoutMs,
    );
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    if (signal?.aborted) return Promise.reject(new Error(`Call to "${this.serverId}" aborted`));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.drop(id);
        reject(new Error(`MCP server "${this.serverId}" timed out after ${timeoutMs} ms (${method})`));
      }, timeoutMs);
      const entry: Pending = { resolve, reject, timer };
      if (signal) {
        const onAbort = (): void => {
          this.drop(id);
          reject(new Error(`Call to "${this.serverId}" aborted`));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detach = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, entry);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async close(): Promise<void> {
    this.fail(new Error(`MCP server "${this.serverId}" was closed`));
    const child = this.child;
    // No pid: the spawn itself failed, so there is no process to wait for.
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  private send(msg: object): void {
    try {
      this.child?.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch (err: unknown) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private drop(id: number): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.detach?.();
    this.pending.delete(id);
  }

  private fail(err: Error): void {
    if (this.dead === null) this.dead = err;
    for (const [id, entry] of [...this.pending]) {
      this.drop(id);
      entry.reject(this.dead);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
      nl = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let msg: { id?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return; // not protocol traffic
    }
    if (typeof msg.id !== 'number') return; // a notification or a server request: not used
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.drop(msg.id);
    if (msg.error) entry.reject(new Error(typeof msg.error.message === 'string' ? msg.error.message : 'MCP error'));
    else entry.resolve(msg.result);
  }
}

interface ToolListEntry {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: unknown };
}

interface ToolCallResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type?: string; text?: string }[];
}

function resultText(result: ToolCallResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

export class McpClientPool {
  private readonly clients = new Map<string, StdioClient>();
  private readonly failed: { server: string; error: string }[] = [];

  constructor(private readonly servers: readonly McpServerConfig[], private readonly parentEnv: NodeJS.ProcessEnv) {}

  /** Starts every server in parallel. One that fails to start is reported by
   *  `failures()` and skipped; it never takes the others down. */
  async start(): Promise<void> {
    await Promise.all(
      this.servers.map(async (s) => {
        const env: Record<string, string> = {};
        for (const key of BASE_ENV_KEYS) {
          const v = this.parentEnv[key];
          if (typeof v === 'string') env[key] = v;
        }
        Object.assign(env, composeServerEnv(s, this.parentEnv));
        const client = new StdioClient(s.id, s, env);
        try {
          await client.start((s.startupTimeoutSec ?? 0) * 1000 || DEFAULT_START_TIMEOUT_MS);
          this.clients.set(s.id, client);
        } catch (err: unknown) {
          this.failed.push({ server: s.id, error: err instanceof Error ? err.message : String(err) });
          await client.close();
        }
      }),
    );
  }

  failures(): readonly { server: string; error: string }[] {
    return this.failed;
  }

  childPids(): number[] {
    return [...this.clients.values()].map((c) => c.pid).filter((p): p is number => p !== undefined);
  }

  async listTools(): Promise<CatalogTool[]> {
    const out: CatalogTool[] = [];
    for (const client of this.clients.values()) {
      if (!client.isAlive) continue;
      try {
        let cursor: string | undefined;
        do {
          const page = (await client.request('tools/list', cursor ? { cursor } : {}, DEFAULT_START_TIMEOUT_MS)) as {
            tools?: ToolListEntry[];
            nextCursor?: string;
          };
          for (const t of page.tools ?? []) {
            if (typeof t.name !== 'string') continue;
            out.push({
              server: client.serverId,
              name: t.name,
              ...(typeof t.description === 'string' && { description: t.description }),
              inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
              ...(t.outputSchema !== undefined && { outputSchema: t.outputSchema }),
              readOnly: classifyTool({ readOnlyHint: t.annotations?.readOnlyHint === true }) === 'read',
            });
          }
          cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
        } while (cursor);
      } catch (err: unknown) {
        this.failed.push({ server: client.serverId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  /** Calls one tool. `structuredContent` wins; otherwise the text is parsed as JSON
   *  when it is JSON and returned as-is when it is not. A tool-level or JSON-RPC
   *  error throws with the server's own message. */
  async call(
    server: string,
    tool: string,
    args: unknown,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const client = this.clients.get(server);
    if (!client) throw new Error(`MCP server "${server}" is not available in this run`);
    const result = (await client.request(
      'tools/call',
      { name: tool, arguments: args ?? {} },
      opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      opts.signal,
    )) as ToolCallResult;
    if (result.isError) throw new Error(resultText(result) || `${server}.${tool} failed`);
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = resultText(result);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
  }
}
