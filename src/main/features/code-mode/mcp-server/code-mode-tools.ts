import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CodeModeEvent } from '../../../../shared/domain/code-mode';
import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { createBridge, type BridgePolicy } from '../application/bridge';
import { generateDeclarations, toIdentifier } from '../domain/declarations';
import type { CatalogTool } from '../domain/tool-catalog';
import type { McpClientPool } from '../infrastructure/mcp-client-pool';
import { runInSandbox, type SandboxOptions } from '../infrastructure/sandbox';
import { checkScript } from '../infrastructure/script-checker';

/**
 * The three tools of `devia-code-mode` (S-50): `search_tools`, `get_types` and
 * `run_script`. Pure of the stdio protocol (that lives in `server.ts`) so it can be
 * tested with real fake MCP servers and no process around it.
 */

export type GatewayLimits = SandboxOptions;

/** Values chosen in the T-547 spike: the script gives up (with its own error)
 *  before pi's 60 s default per-tool timeout would cut it off from outside. */
export const DEFAULT_LIMITS: GatewayLimits = {
  timeoutMs: 50_000,
  memoryBytes: 64 * 1024 * 1024,
  maxOutputBytes: 32 * 1024,
  maxLogBytes: 4 * 1024,
};
export const DEFAULT_POLICY_BUDGETS = { maxCalls: 200, maxCallsPerTool: 100, maxConcurrency: 8 } as const;

const MAX_SEARCH_RESULTS = 20;

export interface ToolDefinition {
  name: 'search_tools' | 'get_types' | 'run_script';
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

type PoolLike = Pick<McpClientPool, 'start' | 'listTools' | 'call' | 'failures' | 'close'>;

export interface GatewayDeps {
  servers: readonly McpServerConfig[];
  pool: PoolLike;
  policy: BridgePolicy;
  limits: GatewayLimits;
  /** Where `CodeModeEvent`s are appended (one `<scriptId>.jsonl` per script); null = nowhere. */
  eventsDir: string | null;
}

const ok = (text: string): ToolResult => ({ text, isError: false });
const fail = (text: string): ToolResult => ({ text, isError: true });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function oneLine(text: string | undefined, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export class CodeModeGateway {
  private ready: Promise<CatalogTool[]> | null = null;
  private scripts = 0;

  constructor(private readonly deps: GatewayDeps) {}

  definitions(): ToolDefinition[] {
    return [
      {
        name: 'search_tools',
        description:
          'Find tools of the MCP servers that are reachable only through scripts. With no query it lists those servers and how many tools each has.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keywords; every word must match the tool name or description.' },
            server: { type: 'string', description: 'Restrict the search to one server.' },
          },
        },
      },
      {
        name: 'get_types',
        description: 'TypeScript declarations of the tools of the given servers: what `tools.<server>.<tool>(args)` accepts and returns.',
        inputSchema: {
          type: 'object',
          properties: { servers: { type: 'array', items: { type: 'string' }, description: 'Server ids.' } },
          required: ['servers'],
        },
      },
      {
        name: 'run_script',
        description:
          'Run a TypeScript script that calls tools of several MCP servers and returns only what you `return`. The body of an async function: top-level `await` and `return` work; `tools` and `console.log` are the only globals. Read-only.',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'The script body.' },
            description: { type: 'string', description: 'One line saying what the script does (shown to the user).' },
          },
          required: ['code'],
        },
      },
    ];
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    const input = isRecord(args) ? args : {};
    try {
      switch (name) {
        case 'search_tools':
          return await this.searchTools(input);
        case 'get_types':
          return await this.getTypes(input);
        case 'run_script':
          return await this.runScript(input);
        default:
          return fail(`Unknown tool: ${name}`);
      }
    } catch (err: unknown) {
      return fail(`devia-code-mode failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async close(): Promise<void> {
    await this.deps.pool.close();
  }

  /** Starts the servers and reads their tool lists once, on first use, so the
   *  agent's handshake with the gateway is instant. */
  private catalog(): Promise<CatalogTool[]> {
    this.ready ??= (async () => {
      await this.deps.pool.start();
      return this.deps.pool.listTools();
    })();
    return this.ready;
  }

  private unavailableNote(): string {
    const failures = this.deps.pool.failures();
    if (failures.length === 0) return '';
    const lines = [...new Map(failures.map((f) => [f.server, f.error])).entries()].map(([s, e]) => `- ${s}: ${e}`);
    return `\n\nServers that are unavailable in this run:\n${lines.join('\n')}`;
  }

  private async searchTools(input: Record<string, unknown>): Promise<ToolResult> {
    const catalog = await this.catalog();
    const query = typeof input['query'] === 'string' ? input['query'].trim().toLowerCase() : '';
    const server = typeof input['server'] === 'string' ? input['server'] : undefined;
    const inServer = (t: CatalogTool): boolean => server === undefined || t.server === server || toIdentifier(t.server) === server;

    if (query === '' && server === undefined) {
      const counts = new Map<string, number>();
      for (const t of catalog) counts.set(t.server, (counts.get(t.server) ?? 0) + 1);
      const lines = this.deps.servers.map((s) => {
        const detail = s.description ? ` — ${oneLine(s.description, 100)}` : '';
        return `${toIdentifier(s.id)}: ${counts.get(s.id) ?? 0} tools${detail}`;
      });
      return ok(`${lines.join('\n')}\n\nCall search_tools with a query, or get_types with the server ids, to see the tools.${this.unavailableNote()}`);
    }

    const words = query.split(/\s+/).filter(Boolean);
    const hits = catalog.filter((t) => {
      if (!inServer(t)) return false;
      const hay = `${t.server} ${t.name} ${t.description ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    if (hits.length === 0) return ok(`No tools match.${this.unavailableNote()}`);
    const shown = hits.slice(0, MAX_SEARCH_RESULTS).map((t) => {
      const desc = t.description ? ` — ${oneLine(t.description, 120)}` : '';
      return `${toIdentifier(t.server)}.${toIdentifier(t.name)}${desc} [${t.readOnly ? 'read' : 'write'}]`;
    });
    const more = hits.length > shown.length ? `\n(${hits.length - shown.length} more: narrow the query)` : '';
    return ok(shown.join('\n') + more + this.unavailableNote());
  }

  private async getTypes(input: Record<string, unknown>): Promise<ToolResult> {
    const catalog = await this.catalog();
    const wanted = Array.isArray(input['servers']) ? input['servers'].filter((s): s is string => typeof s === 'string') : [];
    if (wanted.length === 0) return fail('`servers` must list at least one server id.');
    const known = new Set(this.deps.servers.map((s) => s.id));
    const unknown = wanted.filter((w) => !known.has(w) && ![...known].some((k) => toIdentifier(k) === w));
    if (unknown.length > 0) {
      return fail(`Unknown server(s): ${unknown.join(', ')}. Known: ${[...known].join(', ')}.`);
    }
    const tools = catalog.filter((t) => wanted.includes(t.server) || wanted.includes(toIdentifier(t.server)));
    return ok(generateDeclarations(tools) + this.unavailableNote());
  }

  private async runScript(input: Record<string, unknown>): Promise<ToolResult> {
    const code = typeof input['code'] === 'string' ? input['code'] : '';
    if (code.trim() === '') return fail('`code` is required: the body of the script.');
    const catalog = await this.catalog();

    const startedAt = Date.now();
    const scriptId = `sc-${startedAt.toString(36)}-${++this.scripts}`;
    const codeHash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 16);

    const checked = checkScript(code, generateDeclarations(catalog));
    if (!checked.ok) {
      const lines = checked.diagnostics.slice(0, 10).map((d) => `${d.line}:${d.column} ${d.message}`);
      const failure = fail(
        `The script does not type-check. No tool was called.\n${lines.join('\n')}\n` +
          'Fix it and send it again (get_types shows the exact signatures).',
      );
      // No call was made, but the card still has to learn how this script ended.
      this.publish(scriptId, { type: 'script_started', scriptId, codeHash, at: startedAt });
      this.publish(scriptId, {
        type: 'script_finished', scriptId, ok: false, callCount: 0, bytesFetched: 0, bytesReturned: 0,
        durationMs: Date.now() - startedAt, result: failure.text,
      });
      return failure;
    }

    let calls = 0;
    let denied = 0;
    let bytesFetched = 0;
    const emit = (event: CodeModeEvent): void => {
      if (event.type === 'call_finished') {
        calls++;
        bytesFetched += event.bytes;
        if (event.denied) denied++;
      }
      this.publish(scriptId, event);
    };
    emit({ type: 'script_started', scriptId, codeHash, at: startedAt });

    const bridge = createBridge({ pool: this.deps.pool, catalog, policy: this.deps.policy, emit, scriptId });
    const result = await runInSandbox(checked.js, bridge, this.deps.limits);
    const durationMs = Date.now() - startedAt;
    const returned = result.ok ? Buffer.byteLength(JSON.stringify(result.value) ?? 'null', 'utf8') : 0;

    const stats = { calls, denied, durationMs, bytesFetched, bytesReturned: returned };
    const warnings = this.unavailableNote().trim();
    let outcome: ToolResult;
    if (!result.ok) {
      const where = result.line !== undefined ? ` (line ${result.line})` : '';
      const logs = result.logs.length > 0 ? `\nconsole.log output:\n${result.logs.join('\n')}` : '';
      outcome = fail(`Script failed [${result.kind}]${where}: ${result.message}${logs}\nstats: ${JSON.stringify(stats)}${warnings ? `\n${warnings}` : ''}`);
    } else {
      outcome = ok(
        JSON.stringify({
          value: result.value,
          ...(result.logs.length > 0 && { logs: result.logs }),
          stats,
          ...(warnings && { warnings }),
        }),
      );
    }
    emit({ type: 'script_finished', scriptId, ok: result.ok, callCount: calls, bytesFetched, bytesReturned: returned, durationMs, result: outcome.text });
    return outcome;
  }

  /** Events must never break a script: a full disk only costs the live timeline. */
  private publish(scriptId: string, event: CodeModeEvent): void {
    const dir = this.deps.eventsDir;
    if (dir === null) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${scriptId}.jsonl`), `${JSON.stringify(event)}\n`);
    } catch {
      // see above
    }
  }
}
