import { describe, expect, it, vi } from 'vitest';

import type { CodeModeEvent } from '../../../../shared/domain/code-mode';
import type { CatalogTool } from '../domain/tool-catalog';
import { createBridge, ToolDeniedError, type BridgePolicy } from './bridge';

const CATALOG: CatalogTool[] = [
  { server: 'tiendas', name: 'listar', inputSchema: {}, readOnly: true },
  { server: 'tiendas', name: 'borrar', inputSchema: {}, readOnly: false },
  { server: 'mi-server', name: 'do it', inputSchema: {}, readOnly: true },
];
const POLICY: BridgePolicy = { mode: 'apply', maxCalls: 100, maxCallsPerTool: 100, maxConcurrency: 4 };

function setup(over: Partial<BridgePolicy> = {}, call = vi.fn().mockResolvedValue({ ok: true })) {
  const events: CodeModeEvent[] = [];
  const bridge = createBridge({
    pool: { call },
    catalog: CATALOG,
    policy: { ...POLICY, ...over },
    emit: (e) => events.push(e),
    scriptId: 's1',
  });
  return { bridge, call, events };
}

describe('createBridge', () => {
  it('lets a read tool through and reports start and finish', async () => {
    const { bridge, call, events } = setup();
    await expect(bridge('tiendas', 'listar', { region: 'n' })).resolves.toEqual({ ok: true });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual(['tiendas', 'listar', { region: 'n' }]);
    expect(events.map((e) => e.type)).toEqual(['call_started', 'call_finished']);
    expect(events[1]).toMatchObject({ type: 'call_finished', ok: true, scriptId: 's1' });
  });

  it('denies a write tool without ever calling the server, in every mode', async () => {
    for (const mode of ['plan', 'apply', 'apply-yolo'] as const) {
      const { bridge, call, events } = setup({ mode });
      await expect(bridge('tiendas', 'borrar', {})).rejects.toBeInstanceOf(ToolDeniedError);
      expect(call).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({ type: 'call_finished', ok: false, denied: true });
    }
  });

  it('gives the denial a code the sandbox can recognise', async () => {
    const { bridge } = setup();
    await expect(bridge('tiendas', 'borrar', {})).rejects.toMatchObject({ code: 'TOOL_DENIED' });
  });

  it('rejects an unknown tool with a clear message', async () => {
    const { bridge, call } = setup();
    await expect(bridge('tiendas', 'inventada', {})).rejects.toThrow('tool not found: tiendas.inventada');
    expect(call).not.toHaveBeenCalled();
  });

  it('stops at the total call budget', async () => {
    const { bridge } = setup({ maxCalls: 2 });
    await bridge('tiendas', 'listar', {});
    await bridge('tiendas', 'listar', {});
    await expect(bridge('tiendas', 'listar', {})).rejects.toThrow(/budget/i);
  });

  it('applies the per-tool budget separately', async () => {
    const { bridge } = setup({ maxCallsPerTool: 1 });
    await bridge('tiendas', 'listar', {});
    await expect(bridge('tiendas', 'listar', {})).rejects.toThrow(/budget/i);
    await expect(bridge('mi_server', 'do_it', {})).resolves.toBeTruthy();
  });

  it('never has more calls in flight than maxConcurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const call = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return 1;
    });
    const { bridge } = setup({ maxConcurrency: 3 }, call);
    await Promise.all(Array.from({ length: 20 }, () => bridge('tiendas', 'listar', {})));
    expect(call).toHaveBeenCalledTimes(20);
    expect(peak).toBe(3);
  });

  it('lets the user override the classification of a tool', async () => {
    const { bridge, call } = setup({ writeOverrides: { 'tiendas.borrar': 'read' } });
    await expect(bridge('tiendas', 'borrar', {})).resolves.toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('can also demote a read tool to a write', async () => {
    const { bridge } = setup({ writeOverrides: { 'tiendas.listar': 'write' } });
    await expect(bridge('tiendas', 'listar', {})).rejects.toBeInstanceOf(ToolDeniedError);
  });

  it('counts the serialized size of the response', async () => {
    const { bridge, events } = setup({}, vi.fn().mockResolvedValue({ a: 'xxxx' }));
    await bridge('tiendas', 'listar', {});
    expect(events.at(-1)).toMatchObject({ type: 'call_finished', bytes: JSON.stringify({ a: 'xxxx' }).length });
  });

  it('resolves script-side identifiers back to the real server and tool names', async () => {
    const { bridge, call } = setup();
    await bridge('mi_server', 'do_it', { x: 1 });
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual(['mi-server', 'do it', { x: 1 }]);
  });

  it('reports a failing call as not ok and rethrows the server message', async () => {
    const { bridge, events } = setup({}, vi.fn().mockRejectedValue(new Error('mcp down')));
    await expect(bridge('tiendas', 'listar', {})).rejects.toThrow('mcp down');
    expect(events.at(-1)).toMatchObject({ type: 'call_finished', ok: false, error: 'mcp down' });
    expect(events.at(-1)).not.toHaveProperty('denied');
  });
});
