import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SHIM = path.join(__dirname, '__fixtures__', 'server-shim.cjs');
const FAKE = path.join(__dirname, '..', '__fixtures__', 'fake-mcp-server.cjs');
const REPLY_TIMEOUT_MS = 20_000;

interface Rpc {
  id?: number | string | null;
  result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[]; instructions?: string; serverInfo?: unknown };
  error?: { code: number; message: string };
}

class Proc {
  readonly child: ChildProcessWithoutNullStreams;
  stderr = '';
  private buffer = '';
  private readonly received: Rpc[] = [];
  private waiters: (() => void)[] = [];
  readonly exited: Promise<number | null>;

  constructor(args: string[], env: NodeJS.ProcessEnv = {}) {
    this.child = spawn(process.execPath, [SHIM, ...args], { stdio: 'pipe', env: { ...process.env, ...env } });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf('\n');
      while (nl >= 0) {
        this.received.push(JSON.parse(this.buffer.slice(0, nl)) as Rpc);
        this.buffer = this.buffer.slice(nl + 1);
        nl = this.buffer.indexOf('\n');
      }
      for (const w of this.waiters.splice(0)) w();
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c: string) => (this.stderr += c));
    this.exited = new Promise((resolve) => this.child.on('exit', (code) => resolve(code)));
  }

  request(id: number, method: string, params?: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params && { params }) })}\n`);
  }

  async next(): Promise<Rpc> {
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    while (this.received.length === 0) {
      if (Date.now() > deadline) throw new Error(`no reply; stderr: ${this.stderr}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 200);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    return this.received.shift() as Rpc;
  }
}

let dir: string;
let proc: Proc | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-proc-'));
});
afterEach(async () => {
  if (proc) {
    proc.child.kill();
    await proc.exited;
    proc = undefined;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function serversFile(): string {
  const file = path.join(dir, 'servers.json');
  const fake = (id: string): object => ({ id, name: id, command: process.execPath, args: [FAKE], env: { FAKE_NAME: id }, enabled: true });
  fs.writeFileSync(file, JSON.stringify({ servers: [fake('tiendas'), fake('ventas')] }));
  return file;
}

describe('devia-code-mode server process', () => {
  it('speaks MCP over stdio: initialize, tools/list and an end-to-end run_script', async () => {
    const eventsDir = path.join(dir, 'events');
    proc = new Proc(['--servers-file', serversFile(), '--events-dir', eventsDir], { DEVIA_CODE_MODE_MODE: 'apply' });

    proc.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const init = await proc.next();
    expect(init.result?.serverInfo).toEqual({ name: 'devia-code-mode', version: '1.0.0' });
    expect(init.result?.instructions).toContain('tiendas');
    expect(init.result?.instructions).toContain('ventas');

    proc.request(2, 'tools/list');
    const list = await proc.next();
    expect(list.result?.tools?.map((t) => t.name)).toEqual(['search_tools', 'get_types', 'run_script']);

    proc.request(3, 'tools/call', {
      name: 'run_script',
      arguments: { code: "const a = await tools.tiendas.echo({ value: 'x' });\nreturn a.server;" },
    });
    const run = await proc.next();
    expect(run.result?.isError).toBeUndefined();
    expect(JSON.parse(run.result?.content?.[0]?.text ?? '{}')).toMatchObject({ value: 'tiendas', stats: { calls: 1 } });
    expect(fs.readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1);
  });

  it('survives bad input and unknown tools', async () => {
    proc = new Proc(['--servers-file', serversFile()]);
    proc.child.stdin.write('{not json\n');
    const parse = await proc.next();
    expect(parse.id).toBeNull();
    expect(parse.error?.code).toBe(-32700);

    proc.request(5, 'tools/call', { name: 'nope', arguments: {} });
    const unknown = await proc.next();
    expect(unknown.error?.code).toBe(-32602);
  });

  it('exits with an error when the servers file is missing', async () => {
    proc = new Proc(['--servers-file', path.join(dir, 'does-not-exist.json')]);
    await expect(proc.exited).resolves.toBe(2);
    expect(proc.stderr).toContain('cannot read the servers file');
    proc = undefined;
  });

  it('stops its MCP children when it exits', async () => {
    proc = new Proc(['--servers-file', serversFile()]);
    proc.request(1, 'tools/call', { name: 'search_tools', arguments: { query: 'echo' } });
    await proc.next(); // the pool is up now
    proc.child.stdin.end();
    await expect(proc.exited).resolves.toBe(0);
    proc = undefined;
  });
});
