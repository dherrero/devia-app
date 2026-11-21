import { describe, expect, it } from 'vitest';

import type { ToolCallRecord } from './chat';
import { CODE_MODE_DENIED_PREFIX } from './code-mode';
import { isRunScriptTool, summarizeScript } from './code-mode-summary';

const RUN = 'mcp__devia-code-mode__run_script';
const script = (over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  id: 't1', name: RUN, input: { code: 'return 1;', description: 'Cross stores and sales' }, ...over,
});
const child = (over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  id: 'c1', name: 'tiendas.listar', input: { region: 'norte' }, parentId: 't1', ...over,
});
const ok = (value: unknown, stats: Record<string, number> = {}, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ value, stats: { calls: 2, denied: 0, durationMs: 2300, bytesFetched: 400_000, bytesReturned: 2_000, ...stats }, ...extra });

describe('isRunScriptTool', () => {
  it('recognises the run_script call of every agent and nothing else', () => {
    for (const name of [RUN, 'mcp__devia_code_mode__run_script', 'devia-code-mode.run_script', 'run_script']) {
      expect(isRunScriptTool(name), name).toBe(true);
    }
    for (const name of ['mcp__other__run_script', 'Bash', 'mcp__devia-code-mode__search_tools', '']) {
      expect(isRunScriptTool(name), name).toBe(false);
    }
  });
});

describe('summarizeScript — status', () => {
  it('is running while there is no result yet', () => {
    expect(summarizeScript(script(), [child()]).status).toBe('running');
  });

  it('is ok when the script returned', () => {
    const s = summarizeScript(script({ result: ok({ top: 3 }) }), []);
    expect(s.status).toBe('ok');
    expect(s.preview).toBe('{"top":3}');
  });

  it('is a type error when nothing ran, and says no tool was called', () => {
    const s = summarizeScript(script({ isError: true, result: 'The script does not type-check. No tool was called.\n2:9 Property zona does not exist' }), []);
    expect(s.status).toBe('type_error');
    expect(s.callCount).toBe(0);
    expect(s.preview).toContain('2:9');
  });

  it('is a runtime error with its kind and line', () => {
    const s = summarizeScript(script({ isError: true, result: 'Script failed [runtime] (line 3): boom\nstats: {"calls":1,"denied":0,"durationMs":10,"bytesFetched":5,"bytesReturned":0}' }), []);
    expect(s).toMatchObject({ status: 'runtime_error', failureKind: 'runtime', line: 3 });
    expect(s.preview).toContain('boom');
  });

  it('keeps timeout and memory failures as runtime errors with their kind', () => {
    const s = summarizeScript(script({ isError: true, result: 'Script failed [timeout]: The script ran out of time and was stopped.' }), []);
    expect(s).toMatchObject({ status: 'runtime_error', failureKind: 'timeout' });
  });

  it('is denied when the script died on a refused call', () => {
    const s = summarizeScript(script({ isError: true, result: 'Script failed [runtime]: ToolDeniedError: tiendas.borrar is not read-only' }), []);
    expect(s.status).toBe('denied');
  });

  it('stays ok when a denial was caught, but counts it', () => {
    const s = summarizeScript(script({ result: ok('x', { denied: 2 }) }), []);
    expect(s.status).toBe('ok');
    expect(s.deniedCount).toBe(2);
  });

  it('is a plain error for anything else', () => {
    expect(summarizeScript(script({ isError: true, result: '`code` is required: the body of the script.' }), []).status).toBe('error');
  });

  it('does not break on a success whose text is not JSON', () => {
    const s = summarizeScript(script({ result: 'plain text' }), []);
    expect(s).toMatchObject({ status: 'ok', preview: 'plain text' });
  });
});

describe('summarizeScript — figures', () => {
  it('reads calls, duration and the token estimate from the stats the script returned', () => {
    const s = summarizeScript(script({ result: ok(1) }), []);
    expect(s.callCount).toBe(2);
    expect(s.durationMs).toBe(2300);
    expect(s.tokensSavedEstimate).toBe(99_500); // (400000 - 2000) / 4
  });

  it('has no estimate without stats, and never a negative one', () => {
    expect(summarizeScript(script({ result: 'plain' }), []).tokensSavedEstimate).toBeNull();
    expect(summarizeScript(script({ result: ok(1, { bytesFetched: 10, bytesReturned: 5_000 }) }), []).tokensSavedEstimate).toBe(0);
  });

  it('counts the nested calls it has seen while running', () => {
    const s = summarizeScript(script(), [child(), child({ id: 'c2', name: 'ventas.consultar' })]);
    expect(s.callCount).toBe(2);
    expect(s.servers).toEqual(['tiendas', 'ventas']);
  });

  it('carries the code and the description the agent sent', () => {
    const s = summarizeScript(script(), []);
    expect(s.code).toBe('return 1;');
    expect(s.description).toBe('Cross stores and sales');
  });

  it('carries the logs and the warnings of a successful run', () => {
    const s = summarizeScript(script({ result: ok(1, {}, { logs: ['a', 'b'], warnings: 'Servers that are unavailable in this run:\n- roto: x' }) }), []);
    expect(s.logs).toEqual(['a', 'b']);
    expect(s.warnings).toContain('roto');
  });
});

describe('summarizeScript — nested calls', () => {
  it('tells running, ok, denied and failed calls apart', () => {
    const s = summarizeScript(script(), [
      child({ id: 'a' }),
      child({ id: 'b', result: '120 bytes' }),
      child({ id: 'c', isError: true, result: `${CODE_MODE_DENIED_PREFIX}not read-only` }),
      child({ id: 'd', isError: true, result: 'mcp down' }),
    ]);
    expect(s.calls.map((c) => [c.id, c.state, c.detail])).toEqual([
      ['a', 'running', ''],
      ['b', 'ok', '120 bytes'],
      ['c', 'denied', 'not read-only'],
      ['d', 'error', 'mcp down'],
    ]);
  });

  it('labels a call with its tool and a short version of its arguments', () => {
    const s = summarizeScript(script(), [child({ input: { text: 'x'.repeat(300) } })]);
    expect(s.calls[0]?.label).toBe('tiendas.listar');
    expect(s.calls[0]?.argsText.length).toBeLessThanOrEqual(81);
    expect(s.calls[0]?.argsText.endsWith('…')).toBe(true);
  });
});
