import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CodeModeEvent } from '../../../../shared/domain/code-mode';
import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { McpClientPool } from '../infrastructure/mcp-client-pool';
import { CodeModeGateway, DEFAULT_LIMITS } from './code-mode-tools';

const FIXTURE = path.join(__dirname, '..', '__fixtures__', 'fake-mcp-server.cjs');

function fake(id: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id, name: id, command: process.execPath, args: [FIXTURE], env: { FAKE_NAME: id }, enabled: true, ...extra };
}

interface Result {
  text: string;
  isError: boolean;
}

describe('CodeModeGateway', () => {
  let dir: string;
  let gateway: CodeModeGateway | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-mode-'));
  });
  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function make(servers: McpServerConfig[] = [fake('tiendas'), fake('ventas')], limits = DEFAULT_LIMITS): CodeModeGateway {
    const pool = new McpClientPool(servers, process.env);
    gateway = new CodeModeGateway({
      servers,
      pool,
      policy: { mode: 'apply', maxCalls: 50, maxCallsPerTool: 50, maxConcurrency: 4 },
      limits,
      eventsDir: dir,
    });
    return gateway;
  }
  const run = async (g: CodeModeGateway, code: string): Promise<Result> => g.call('run_script', { code });
  const parse = (r: Result): { value: unknown; logs?: string[]; stats: Record<string, number> } =>
    JSON.parse(r.text) as { value: unknown; logs?: string[]; stats: Record<string, number> };

  it('lists exactly the three tools', () => {
    expect(make().definitions().map((d) => d.name)).toEqual(['search_tools', 'get_types', 'run_script']);
  });

  it('search_tools filters by query and by server and marks read/write', async () => {
    const g = make();
    const echo = await g.call('search_tools', { query: 'echo' });
    expect(echo.isError).toBe(false);
    expect(echo.text).toContain('tiendas.echo');
    expect(echo.text).toContain('[read]');
    expect(echo.text).not.toContain('write_thing');
    const write = await g.call('search_tools', { query: 'write_thing', server: 'ventas' });
    expect(write.text).toContain('ventas.write_thing');
    expect(write.text).toContain('[write]');
    expect(write.text).not.toContain('tiendas.');
  });

  it('search_tools without a query summarises the servers', async () => {
    const out = await make().call('search_tools', {});
    expect(out.text).toContain('tiendas');
    expect(out.text).toContain('ventas');
    expect(out.text).toMatch(/\d+ tools/);
  });

  it('get_types returns the declarations of the requested servers only', async () => {
    const out = await make().call('get_types', { servers: ['tiendas'] });
    expect(out.text).toContain('declare const tools');
    expect(out.text).toContain('tiendas');
    expect(out.text).not.toContain('ventas');
  });

  it('get_types names an unknown server instead of returning nothing', async () => {
    const out = await make().call('get_types', { servers: ['nope'] });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('nope');
  });

  it('run_script crosses two servers in one call and reports stats', async () => {
    const g = make();
    const r = await run(
      g,
      "const a = await tools.tiendas.echo({ value: 'x' });\nconst b = await tools.ventas.echo({ value: a.server });\nreturn { a, b };",
    );
    expect(r.isError).toBe(false);
    const out = parse(r);
    expect(out.value).toEqual({
      a: { echo: { value: 'x' }, server: 'tiendas' },
      b: { echo: { value: 'tiendas' }, server: 'ventas' },
    });
    expect(out.stats).toMatchObject({ calls: 2, denied: 0 });
  });

  it('a type error is reported before any call is made', async () => {
    const g = make();
    const r = await run(g, "return await tools.tiendas.echo({ valor: 'x' });");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no tool was called/i);
    expect(r.text).toMatch(/1:\d+/);
    // No tool ran, but the card still needs to know how it ended: only the script's own
    // start and finish are published, and the finish carries the text the agent got.
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    const events = fs.readFileSync(path.join(dir, files[0] as string), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as CodeModeEvent);
    expect(events.map((e) => e.type)).toEqual(['script_started', 'script_finished']);
    const last = events[1];
    expect(last).toMatchObject({ type: 'script_finished', ok: false, callCount: 0 });
    expect(last?.type === 'script_finished' && last.result).toBe(r.text);
  });

  it('a denied write is catchable, distinguishable and still counted in the stats', async () => {
    const g = make();
    const r = await run(g, 'try { await tools.tiendas.write_thing({}); return "wrote"; } catch (e) { return e.name; }');
    expect(r.isError).toBe(false);
    const out = parse(r);
    expect(out.value).toBe('ToolDeniedError');
    expect(out.stats['denied']).toBe(1);
  });

  it('an uncaught denial fails the run with the error name in the message', async () => {
    const r = await run(make(), 'await tools.tiendas.write_thing({});');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('ToolDeniedError');
  });

  it('a runtime error says which kind it is', async () => {
    const r = await run(make(), "throw new Error('boom');");
    expect(r.isError).toBe(true);
    expect(r.text).toContain('runtime');
    expect(r.text).toContain('boom');
  });

  it('a script that returns too much is refused with advice', async () => {
    const g = make(undefined, { ...DEFAULT_LIMITS, maxOutputBytes: 100 });
    const r = await run(g, "return 'x'.repeat(5000);");
    expect(r.isError).toBe(true);
    expect(r.text).toContain('output_too_large');
  });

  it('keeps going when one server is unavailable and says so', async () => {
    const g = make([fake('tiendas'), fake('roto', { command: '/not/a/binary' })]);
    const r = await run(g, "return await tools.tiendas.echo({ value: 'x' });");
    expect(r.isError).toBe(false);
    expect(r.text).toContain('roto');
  });

  it('publishes script and call events as JSONL', async () => {
    const g = make();
    await run(g, "return await tools.tiendas.echo({ value: 'x' });");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    const events = fs
      .readFileSync(path.join(dir, files[0] as string), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as CodeModeEvent);
    expect(events.map((e) => e.type)).toEqual(['script_started', 'call_started', 'call_finished', 'script_finished']);
    const started = events[0];
    expect(started?.type === 'script_started' && started.codeHash).toMatch(/^[0-9a-f]{16}$/);
    const finished = events.at(-1);
    expect(finished).toMatchObject({ type: 'script_finished', ok: true, callCount: 1 });
    // The text the agent received, so the chat can show it even when the agent's own
    // stream does not carry tool results.
    expect(JSON.parse((finished as { result: string }).result)).toMatchObject({ value: { server: 'tiendas' }, stats: { calls: 1 } });
    expect(finished?.type === 'script_finished' && finished.bytesFetched).toBeGreaterThan(0);
  });

  it('rejects an unknown tool and an empty script', async () => {
    const g = make();
    await expect(g.call('nope', {})).resolves.toMatchObject({ isError: true });
    await expect(g.call('run_script', { code: '   ' })).resolves.toMatchObject({ isError: true });
  });
});
