import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireWriterLock } from '../engine/db/writer-lock';
import { perfBudget } from '../engine/graph/test-graph';
import { CodeGraphStore } from '../infrastructure/code-graph-store';
import { FIRST_INDEX_TEXT } from './graph-tools';

const SHIM = path.join(__dirname, '__fixtures__', 'server-shim.cjs');
/** Longest wait for one reply; a hung server fails the test with its stderr instead of timing it out. */
const REPLY_TIMEOUT_MS = 15_000;
const live = new Set<ServerProcess>();

interface Rpc {
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class ServerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly startedAt = performance.now();
  stderr = '';
  private buffer = '';
  private readonly received: Rpc[] = [];
  private waiters: (() => void)[] = [];
  private done = false;
  readonly exited: Promise<number | null>;

  constructor(args: string[]) {
    this.child = spawn(process.execPath, [SHIM, ...args], { stdio: 'pipe' });
    live.add(this);
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf('\n');
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.received.push(JSON.parse(line) as Rpc);
        nl = this.buffer.indexOf('\n');
      }
      for (const w of this.waiters.splice(0)) w();
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => (this.stderr += chunk));
    this.exited = new Promise((resolve) =>
      this.child.on('exit', (code) => {
        this.done = true;
        live.delete(this);
        for (const w of this.waiters.splice(0)) w();
        resolve(code);
      }),
    );
  }

  send(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  request(id: number, method: string, params?: Record<string, unknown>): void {
    this.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params && { params }) }));
  }

  async next(timeoutMs = REPLY_TIMEOUT_MS): Promise<Rpc> {
    const deadline = performance.now() + timeoutMs;
    while (this.received.length === 0) {
      if (this.done) throw new Error(`server exited early; stderr: ${this.stderr}`);
      const left = deadline - performance.now();
      if (left <= 0) throw new Error(`no reply within ${timeoutMs} ms; stderr: ${this.stderr}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const msg = this.received.shift();
    if (!msg) throw new Error('no message');
    return msg;
  }

  pending(): number {
    return this.received.length;
  }
}

let deviaDir: string;
let projectDir: string;

beforeEach(() => {
  deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-proc-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-proj-'));
});

afterEach(async () => {
  // A failed assertion must not leave a server running (and holding the temp dirs on Windows).
  const exits = [...live].map((srv) => {
    srv.child.kill();
    return srv.exited;
  });
  await Promise.all(exits);
  fs.rmSync(deviaDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('devia-code-graph server process', () => {
  it('speaks newline-delimited JSON-RPC over stdio and survives bad input', async () => {
    const srv = new ServerProcess(['--devia-dir', deviaDir, '--project', projectDir]);
    srv.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const init = await srv.next();
    const startupMs = performance.now() - srv.startedAt;
    expect(init.id).toBe(1);
    expect(init.result?.['serverInfo']).toEqual({ name: 'devia-code-graph', version: '1.0.0' });
    expect(init.result?.['protocolVersion']).toBe('2025-06-18');
    expect(String(init.result?.['instructions'])).toContain('graph_explore');

    srv.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    srv.request(2, 'tools/list');
    const list = await srv.next();
    expect(list.id).toBe(2);
    const tools = list.result?.['tools'] as { name: string }[];
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['graph_affected', 'graph_callees', 'graph_callers', 'graph_explore', 'graph_files', 'graph_impact', 'graph_node', 'graph_search', 'graph_status'],
    );

    srv.request(3, 'tools/call', { name: 'graph_status', arguments: {} });
    const status = await srv.next();
    expect(status.id).toBe(3);
    expect(status.result?.['isError']).toBeUndefined();
    expect(JSON.stringify(status.result?.['content'])).toContain('has not indexed this project in Devia');

    srv.send('{not json');
    const parse = await srv.next();
    expect(parse.id).toBeNull();
    expect(parse.error?.code).toBe(-32700);

    srv.send(JSON.stringify({ jsonrpc: '2.0', id: 4, params: {} }));
    expect((await srv.next()).error?.code).toBe(-32600);

    srv.request(5, 'resources/whatever');
    const unknown = await srv.next();
    expect(unknown).toMatchObject({ id: 5, error: { code: -32601 } });

    srv.request(6, 'tools/call', { name: 'graph_nope', arguments: {} });
    expect(await srv.next()).toMatchObject({ id: 6, error: { code: -32602 } });

    srv.send(JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'graph_status' } }));
    srv.request(7, 'ping');
    expect(await srv.next()).toMatchObject({ id: 7, result: {} });

    srv.child.stdin.end();
    expect(await srv.exited).toBe(0);
    expect(srv.pending()).toBe(0);
    expect(srv.stderr).toContain('web-tree-sitter loaded: false');
    expect(startupMs).toBeLessThan(perfBudget(STARTUP_IDLE_MS));
  }, 20_000);

  it('answers with the first-index guidance while the first index runs', async () => {
    const dataDir = new CodeGraphStore(() => deviaDir).dataDir(projectDir);
    fs.mkdirSync(dataDir, { recursive: true });
    const lock = acquireWriterLock(dataDir, 'indexer');
    expect(lock).not.toBeNull();
    try {
      const srv = new ServerProcess(['--devia-dir', deviaDir, '--project', projectDir]);
      srv.request(1, 'tools/call', { name: 'graph_search', arguments: { query: 'a' } });
      const reply = await srv.next();
      expect(reply.id).toBe(1);
      expect(reply.result?.['isError']).toBeUndefined();
      expect(reply.result?.['content']).toEqual([{ type: 'text', text: FIRST_INDEX_TEXT }]);
      srv.child.stdin.end();
      expect(await srv.exited).toBe(0);
    } finally {
      lock?.release();
    }
  }, 20_000);

  it('exits with code 2 when --project is missing or relative', async () => {
    const missing = new ServerProcess(['--devia-dir', deviaDir]);
    expect(await missing.exited).toBe(2);
    expect(missing.stderr).toContain('[devia-code-graph]');
    const relative = new ServerProcess(['--devia-dir', deviaDir, '--project', 'relative/dir']);
    expect(await relative.exited).toBe(2);
  }, 20_000);

  it('exits cleanly on SIGTERM', async () => {
    const srv = new ServerProcess(['--devia-dir', deviaDir, '--project', projectDir]);
    srv.request(1, 'ping');
    await srv.next();
    srv.child.kill('SIGTERM');
    const code = await srv.exited;
    expect(process.platform === 'win32' || code === 0).toBe(true);
  }, 20_000);
});

/**
 * Includes the tsx transpile of the server's module graph, which the compiled `dist` entry does
 * not pay; the compiled server is measured separately in the smoke run.
 */
const STARTUP_IDLE_MS = 300;
