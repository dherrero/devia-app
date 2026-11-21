import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../../../shared/domain/agent-event';
import { CODE_MODE_DENIED_PREFIX, type CodeModeEvent } from '../../../../shared/domain/code-mode';
import { CodeModeEventRelay } from './code-mode-event-relay';

const hash = (code: string): string => crypto.createHash('sha256').update(code).digest('hex').slice(0, 16);
const RUN_SCRIPT = 'mcp__devia-code-mode__run_script';

describe('CodeModeEventRelay', () => {
  let dir: string;
  let out: AgentEvent[];
  let relay: CodeModeEventRelay;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-relay-'));
    out = [];
    relay = new CodeModeEventRelay({ eventsDir: dir, emit: (e) => out.push(e) });
  });
  afterEach(() => {
    relay.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (scriptId: string, ...events: CodeModeEvent[]): void =>
    fs.appendFileSync(path.join(dir, `${scriptId}.jsonl`), events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  const started = (scriptId: string, code: string): CodeModeEvent => ({ type: 'script_started', scriptId, codeHash: hash(code), at: 1 });
  const callStarted = (scriptId: string, callId: string, tool = 'listar'): CodeModeEvent => ({
    type: 'call_started', scriptId, callId, server: 'tiendas', tool, args: { region: 'n' }, at: 2,
  });
  const callFinished = (scriptId: string, callId: string, over: Partial<Extract<CodeModeEvent, { type: 'call_finished' }>> = {}): CodeModeEvent => ({
    type: 'call_finished', scriptId, callId, ok: true, bytes: 120, durationMs: 5, ...over,
  });
  const agentCall = (id: string, code: string, name = RUN_SCRIPT): AgentEvent => ({ type: 'tool_use', id, name, input: { code } });

  it('shows each internal call as a tool call nested under the matching run_script', () => {
    relay.observeAgentEvent(agentCall('toolu_1', 'S1'));
    write('s1', started('s1', 'S1'), callStarted('s1', 'c1'), callFinished('s1', 'c1'));
    relay.flush();
    expect(out).toEqual([
      { type: 'tool_use', id: 'c1', name: 'tiendas.listar', input: { region: 'n' }, parentToolUseId: 'toolu_1' },
      { type: 'tool_result', toolUseId: 'c1', content: '120 bytes', isError: false },
    ]);
  });

  it('keeps two simultaneous scripts under their own cards', () => {
    relay.observeAgentEvent(agentCall('toolu_A', 'SCRIPT A'));
    relay.observeAgentEvent(agentCall('toolu_B', 'SCRIPT B'));
    write('b', started('b', 'SCRIPT B'), callStarted('b', 'b1'));
    write('a', started('a', 'SCRIPT A'), callStarted('a', 'a1'));
    relay.flush();
    const parents = Object.fromEntries(out.flatMap((e) => (e.type === 'tool_use' ? [[e.id, e.parentToolUseId]] : [])));
    expect(parents).toEqual({ a1: 'toolu_A', b1: 'toolu_B' });
  });

  it('never emits an event twice, however many times it reads the files', () => {
    relay.observeAgentEvent(agentCall('toolu_1', 'S1'));
    write('s1', started('s1', 'S1'), callStarted('s1', 'c1'));
    relay.flush();
    relay.flush();
    write('s1', callFinished('s1', 'c1'));
    relay.flush();
    relay.flush();
    expect(out.map((e) => e.type)).toEqual(['tool_use', 'tool_result']);
  });

  it('waits for a complete line before parsing it', () => {
    relay.observeAgentEvent(agentCall('toolu_1', 'S1'));
    const line = JSON.stringify(callStarted('s1', 'c1'));
    write('s1', started('s1', 'S1'));
    fs.appendFileSync(path.join(dir, 's1.jsonl'), line.slice(0, 20));
    relay.flush();
    expect(out).toEqual([]);
    fs.appendFileSync(path.join(dir, 's1.jsonl'), `${line.slice(20)}\n`);
    relay.flush();
    expect(out.map((e) => e.type)).toEqual(['tool_use']);
  });

  const scriptFinished = (scriptId: string, over: Partial<Extract<CodeModeEvent, { type: 'script_finished' }>> = {}): CodeModeEvent => ({
    type: 'script_finished', scriptId, ok: true, callCount: 1, bytesFetched: 10, bytesReturned: 5, durationMs: 40, result: '{"value":1,"stats":{}}', ...over,
  });

  it('gives the run_script card its own result when the script ends, after its nested calls', () => {
    relay.observeAgentEvent(agentCall('toolu_1', 'S1'));
    write('s1', started('s1', 'S1'), callStarted('s1', 'c1'), callFinished('s1', 'c1'), scriptFinished('s1'));
    relay.flush();
    expect(out.map((e) => e.type)).toEqual(['tool_use', 'tool_result', 'tool_result']);
    expect(out[2]).toEqual({ type: 'tool_result', toolUseId: 'toolu_1', content: '{"value":1,"stats":{}}', isError: false });
  });

  it('marks the script result as an error when it failed', () => {
    relay.observeAgentEvent(agentCall('toolu_1', 'S1'));
    write('s1', started('s1', 'S1'), scriptFinished('s1', { ok: false, callCount: 0, result: 'The script does not type-check. No tool was called.' }));
    relay.flush();
    expect(out).toEqual([{ type: 'tool_result', toolUseId: 'toolu_1', content: 'The script does not type-check. No tool was called.', isError: true }]);
  });

  it('says nothing about the script result when an older gateway did not publish it', () => {
    relay.observeAgentEvent(agentCall('toolu_1', 'S1'));
    write('s1', started('s1', 'S1'), scriptFinished('s1', { result: undefined as unknown as string }));
    relay.flush();
    expect(out).toEqual([]);
  });

  it('marks a denied call as an error the card can tell apart from a failure', () => {
    relay.observeAgentEvent(agentCall('toolu_1', 'S1'));
    write('s1', started('s1', 'S1'), callStarted('s1', 'c1', 'borrar'), callFinished('s1', 'c1', { ok: false, denied: true, bytes: 0, error: 'not read-only' }));
    relay.flush();
    const result = out.find((e) => e.type === 'tool_result');
    expect(result).toEqual({ type: 'tool_result', toolUseId: 'c1', content: `${CODE_MODE_DENIED_PREFIX}not read-only`, isError: true });
  });

  it('reports a failed call with the server message', () => {
    relay.observeAgentEvent(agentCall('toolu_1', 'S1'));
    write('s1', started('s1', 'S1'), callStarted('s1', 'c1'), callFinished('s1', 'c1', { ok: false, bytes: 0, error: 'mcp down' }));
    relay.flush();
    expect(out.find((e) => e.type === 'tool_result')).toEqual({ type: 'tool_result', toolUseId: 'c1', content: 'mcp down', isError: true });
  });

  it('holds events that arrive before the agent reports its run_script, then releases them', () => {
    write('s1', started('s1', 'S1'), callStarted('s1', 'c1'));
    relay.flush();
    expect(out).toEqual([]);
    relay.observeAgentEvent(agentCall('toolu_1', 'S1'));
    expect(out.map((e) => e.type)).toEqual(['tool_use']);
    expect((out[0] as Extract<AgentEvent, { type: 'tool_use' }>).parentToolUseId).toBe('toolu_1');
  });

  it('recognises the run_script call of every agent, and nothing else', () => {
    for (const name of ['mcp__devia-code-mode__run_script', 'mcp__devia_code_mode__run_script', 'devia-code-mode.run_script', 'run_script']) {
      out = [];
      const r = new CodeModeEventRelay({ eventsDir: dir, emit: (e) => out.push(e) });
      r.observeAgentEvent(agentCall('t', 'X', name));
      fs.rmSync(path.join(dir, 'x.jsonl'), { force: true });
      write('x', started('x', 'X'), callStarted('x', 'c'));
      r.flush();
      expect(out.length, name).toBe(1);
    }
    out = [];
    const other = new CodeModeEventRelay({ eventsDir: dir, emit: (e) => out.push(e) });
    other.observeAgentEvent(agentCall('t', 'Y', 'mcp__someone-else__run_script'));
    write('y', started('y', 'Y'), callStarted('y', 'c'));
    other.flush();
    expect(out).toEqual([]);
  });

  it('on stop, flushes what is left and pairs a lone unmatched script with the only open run_script', () => {
    relay.observeAgentEvent(agentCall('toolu_1', 'the code as the agent sent it'));
    write('s1', started('s1', 'a different hash because the agent tool input was rewritten'), callStarted('s1', 'c1'));
    relay.flush();
    expect(out).toEqual([]);
    relay.stop();
    expect(out.map((e) => e.type)).toEqual(['tool_use']);
  });

  it('ignores a directory that does not exist yet', () => {
    const lazy = new CodeModeEventRelay({ eventsDir: path.join(dir, 'later'), emit: (e) => out.push(e) });
    expect(() => lazy.flush()).not.toThrow();
  });
});
