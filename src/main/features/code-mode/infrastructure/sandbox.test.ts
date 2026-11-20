import { describe, expect, it, vi } from 'vitest';

import { runInSandbox, type BridgeFn, type SandboxOptions } from './sandbox';

const OPTS: SandboxOptions = { timeoutMs: 2_000, memoryBytes: 16 * 1024 * 1024, maxOutputBytes: 10_000, maxLogBytes: 200 };
const noBridge: BridgeFn = () => Promise.reject(new Error('no tools in this test'));

describe('runInSandbox', () => {
  it('returns the value of the script', async () => {
    const r = await runInSandbox('return 1 + 1;', noBridge, OPTS);
    expect(r).toEqual({ ok: true, value: 2, logs: [] });
  });

  it('exposes no ambient capabilities', async () => {
    const r = await runInSandbox(
      'return [typeof process, typeof require, typeof fetch, typeof globalThis.fs, typeof setTimeout, typeof Buffer];',
      noBridge,
      OPTS,
    );
    expect(r).toEqual({ ok: true, value: Array(6).fill('undefined'), logs: [] });
  });

  it('kills a script that spins forever', async () => {
    const started = Date.now();
    const r = await runInSandbox('while (true) {}', noBridge, { ...OPTS, timeoutMs: 300 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('kills a script that awaits a call that never resolves', async () => {
    const never: BridgeFn = () => new Promise(() => undefined);
    const r = await runInSandbox('return await tools.a.b({});', never, { ...OPTS, timeoutMs: 300 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('timeout');
  });

  it('reports memory exhaustion', async () => {
    const r = await runInSandbox('const big = new Array(5000000).fill(1); return big.length;', noBridge, {
      ...OPTS,
      memoryBytes: 4 * 1024 * 1024,
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('memory');
  });

  it('keeps running scripts after one ran out of memory (QuickJS may abort while freeing that runtime)', async () => {
    const oom = await runInSandbox('const big = new Array(5000000).fill(1); return big.length;', noBridge, { ...OPTS, memoryBytes: 4 * 1024 * 1024 });
    expect(oom.ok).toBe(false);
    for (let i = 0; i < 3; i++) {
      await expect(runInSandbox(`return ${i} + 1;`, noBridge, OPTS)).resolves.toEqual({ ok: true, value: i + 1, logs: [] });
    }
  });

  it('calls the bridge with the names and arguments of the script', async () => {
    const bridge = vi.fn<BridgeFn>().mockResolvedValue({ ok: [1, 2] });
    const r = await runInSandbox('return await tools.a.b({ x: 1 });', bridge, OPTS);
    expect(bridge).toHaveBeenCalledWith('a', 'b', { x: 1 });
    expect(r).toEqual({ ok: true, value: { ok: [1, 2] }, logs: [] });
  });

  it('runs Promise.all over several calls', async () => {
    const bridge: BridgeFn = (_s, tool) => Promise.resolve(`done:${tool}`);
    const r = await runInSandbox('return await Promise.all([tools.a.x({}), tools.a.y({}), tools.b.z({})]);', bridge, OPTS);
    expect(r).toEqual({ ok: true, value: ['done:x', 'done:y', 'done:z'], logs: [] });
  });

  it('lets the script catch a rejected call', async () => {
    const bridge: BridgeFn = () => Promise.reject(new Error('mcp down'));
    const r = await runInSandbox(
      "try { await tools.a.b({}); return 'no'; } catch (e) { return 'caught: ' + e.message; }",
      bridge,
      OPTS,
    );
    expect(r).toEqual({ ok: true, value: 'caught: mcp down', logs: [] });
  });

  it('keeps the error name of a denied call so the script can tell it apart', async () => {
    const denied = Object.assign(new Error('write tools are not allowed'), { code: 'TOOL_DENIED' });
    const bridge: BridgeFn = () => Promise.reject(denied);
    const r = await runInSandbox("try { await tools.a.b({}); } catch (e) { return e.name; }", bridge, OPTS);
    expect(r).toEqual({ ok: true, value: 'ToolDeniedError', logs: [] });
  });

  it('refuses a result bigger than maxOutputBytes', async () => {
    const r = await runInSandbox("return 'x'.repeat(50000);", noBridge, { ...OPTS, maxOutputBytes: 1_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('output_too_large');
  });

  it('collects console.log and truncates it to maxLogBytes', async () => {
    const r = await runInSandbox("console.log('hello', { a: 1 }); console.log('y'.repeat(1000)); return 1;", noBridge, OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.logs[0]).toBe('hello {"a":1}');
      expect(r.logs.join('').length).toBeLessThan(400);
      expect(r.logs[r.logs.length - 1]).toContain('truncated');
    }
  });

  it('reports a runtime error with the line of the script', async () => {
    const r = await runInSandbox("\n\nthrow new Error('boom');", noBridge, OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('runtime');
      expect(r.message).toContain('boom');
      expect(r.line).toBe(3);
    }
  });

  it('returns null for a script that returns nothing', async () => {
    const r = await runInSandbox('const x = 1;', noBridge, OPTS);
    expect(r).toEqual({ ok: true, value: null, logs: [] });
  });
});
