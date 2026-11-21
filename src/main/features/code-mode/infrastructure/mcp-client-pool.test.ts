import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { McpClientPool } from './mcp-client-pool';

const FIXTURE = path.join(__dirname, '..', '__fixtures__', 'fake-mcp-server.cjs');

function fake(id: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id, name: id, command: process.execPath, args: [FIXTURE], env: { FAKE_NAME: id }, enabled: true, ...extra };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('McpClientPool', () => {
  let pool: McpClientPool | undefined;
  afterEach(async () => {
    await pool?.close();
    pool = undefined;
  });

  async function started(...servers: McpServerConfig[]): Promise<McpClientPool> {
    pool = new McpClientPool(servers, process.env);
    await pool.start();
    return pool;
  }

  it('lists the tools of every server across pages, with the read/write classification', async () => {
    const p = await started(fake('tiendas'));
    const tools = await p.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(tools.every((t) => t.server === 'tiendas')).toBe(true);
    expect(byName.get('echo')?.readOnly).toBe(true);
    expect(byName.get('write_thing')?.readOnly).toBe(false);
    expect(byName.has('slow')).toBe(true); // came from the second page
  });

  it('returns structuredContent when the server sends it', async () => {
    const p = await started(fake('a'));
    await expect(p.call('a', 'echo', { value: 'x' })).resolves.toEqual({ echo: { value: 'x' }, server: 'a' });
  });

  it('parses a JSON text result and passes plain text through', async () => {
    const p = await started(fake('a'));
    await expect(p.call('a', 'text_json', {})).resolves.toEqual({ a: 1 });
    await expect(p.call('a', 'text_plain', {})).resolves.toBe('hello');
  });

  it('throws with the server message when the tool reports isError', async () => {
    const p = await started(fake('a'));
    await expect(p.call('a', 'fail', {})).rejects.toThrow('boom from server');
  });

  it('throws with the message of a JSON-RPC error', async () => {
    const p = await started(fake('a'));
    await expect(p.call('a', 'rpc_error', {})).rejects.toThrow('rpc exploded');
  });

  it('rejects for an unknown server', async () => {
    const p = await started(fake('a'));
    await expect(p.call('nope', 'echo', {})).rejects.toThrow(/nope/);
  });

  it('keeps the other servers working when one dies mid-run', async () => {
    const p = await started(fake('a'), fake('b'));
    await expect(p.call('a', 'die', {})).rejects.toThrow();
    await expect(p.call('a', 'echo', {})).rejects.toThrow();
    await expect(p.call('b', 'echo', { value: 1 })).resolves.toEqual({ echo: { value: 1 }, server: 'b' });
  });

  it('survives a server that cannot start and reports it', async () => {
    pool = new McpClientPool([fake('ok'), fake('bad', { command: '/definitely/not/a/binary' })], process.env);
    await pool.start();
    expect(pool.failures().map((f) => f.server)).toEqual(['bad']);
    await expect(pool.call('ok', 'echo', {})).resolves.toBeTruthy();
    const tools = await pool.listTools();
    expect(tools.every((t) => t.server === 'ok')).toBe(true);
  });

  it('rejects a call that exceeds its timeout', async () => {
    const p = await started(fake('a'));
    await expect(p.call('a', 'slow', { ms: 2_000 }, { timeoutMs: 100 })).rejects.toThrow(/timed out/i);
  });

  it('rejects a call whose signal aborts', async () => {
    const p = await started(fake('a'));
    const ac = new AbortController();
    const call = p.call('a', 'slow', { ms: 2_000 }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(call).rejects.toThrow(/abort/i);
  });

  it('does not hand the parent environment to a server that did not allow it', async () => {
    pool = new McpClientPool(
      [fake('closed'), fake('open', { allowedEnvKeys: ['SECRET_TOKEN'] })],
      { ...process.env, SECRET_TOKEN: 's3cret', OTHER_SECRET: 'x' },
    );
    await pool.start();
    const closed = (await pool.call('closed', 'env_keys', {})) as string[];
    const open = (await pool.call('open', 'env_keys', {})) as string[];
    expect(closed).not.toContain('SECRET_TOKEN');
    expect(closed).not.toContain('OTHER_SECRET');
    expect(open).toContain('SECRET_TOKEN');
    expect(open).not.toContain('OTHER_SECRET');
  });

  it('kills every child on close', async () => {
    const p = await started(fake('a'), fake('b'));
    const pids = p.childPids();
    expect(pids).toHaveLength(2);
    await p.close();
    await new Promise((r) => setTimeout(r, 100));
    for (const pid of pids) expect(alive(pid)).toBe(false);
  });
});
