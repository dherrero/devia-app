/**
 * Tests for the pi `--mode rpc` session driver: prompt command framing, event
 * mapping (agent_start / message_update / turn_end / agent_end), extension-UI
 * auto-reply, and prompt-rejection handling.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { runPiRpcSession, mapPiRpcEvent, normalizePiToolName } from './rpc-driver';
import type { AgentEvent } from '../../../../shared/domain/agent-event';

class FakeStdin {
  writes: string[] = [];
  write(s: string): boolean { this.writes.push(s); return true; }
  end(): void { /* noop */ }
  on(): this { return this; }
}
class FakeChild extends EventEmitter {
  killed = false;
  stdin = new FakeStdin();
  stdout = new EventEmitter();
  kill(): boolean { this.killed = true; return true; }
}

function writes(child: FakeChild): Array<Record<string, unknown>> {
  return child.stdin.writes.join('').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}
function out(child: FakeChild, obj: unknown): void {
  child.stdout.emit('data', `${JSON.stringify(obj)}\n`);
}

describe('runPiRpcSession', () => {
  it('sends a prompt command and maps streamed events to AgentEvents', () => {
    const child = new FakeChild();
    const events: AgentEvent[] = [];
    runPiRpcSession({ child: child as unknown as ChildProcess, prompt: 'hi', model: null, emit: (e) => events.push(e) });

    // status initializing emitted immediately; prompt command written.
    expect(events[0]).toMatchObject({ type: 'status', label: 'initializing' });
    const first = writes(child)[0];
    expect(first).toMatchObject({ id: 1, type: 'prompt', message: 'hi' });

    expect(writes(child)[1]).toMatchObject({ id: 2, type: 'get_state' });

    out(child, { type: 'agent_start' });
    out(child, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } });
    out(child, { type: 'turn_end', message: { usage: { input: 5, output: 3 } } });
    out(child, { type: 'agent_end' });

    expect(events).toContainEqual({ type: 'status', label: 'working' });
    expect(events.some((e) => e.type === 'status' && e.label === 'streaming')).toBe(true);
    expect(events).toContainEqual({ type: 'text_delta', delta: 'Hello' });
    expect(events).toContainEqual({ type: 'usage', inputTokens: 5, outputTokens: 3, cachedInputTokens: 0 });
    // agent_end is NOT the end: retries / compaction / queued work may follow.
    expect(events.some((e) => e.type === 'turn_end')).toBe(false);
    out(child, { type: 'agent_settled', aborted: false });
    expect(events).toContainEqual({ type: 'turn_end', stopReason: 'completed' });
  });

  it('surfaces the session id, model and context window from get_state', () => {
    const child = new FakeChild();
    const events: AgentEvent[] = [];
    runPiRpcSession({ child: child as unknown as ChildProcess, prompt: 'hi', model: null, emit: (e) => events.push(e) });
    out(child, {
      type: 'response', id: 2, command: 'get_state', success: true,
      data: { sessionId: 'sess-1', model: { id: 'kimi-k2.6', provider: 'openrouter', contextWindow: 262144 } },
    });
    expect(events).toContainEqual({ type: 'session_started', agentSessionId: 'sess-1' });
    expect(events).toContainEqual({ type: 'status', label: 'model', model: 'openrouter/kimi-k2.6' });
    out(child, { type: 'turn_end', message: { usage: { input: 100, output: 10, cacheRead: 40, cacheWrite: 2, cost: { total: 0.5 } } } });
    out(child, { type: 'turn_end', message: { usage: { input: 120, output: 20, cacheRead: 50, cacheWrite: 0, cost: { total: 0.25 } } } });
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage[0]).toEqual({ type: 'usage', inputTokens: 100, outputTokens: 10, cachedInputTokens: 42, costUsd: 0.5, contextWindow: 262144 });
    // Tokens are the LAST request (context fill); cost accumulates over the run.
    expect(usage[1]).toEqual({ type: 'usage', inputTokens: 120, outputTokens: 20, cachedInputTokens: 50, costUsd: 0.75, contextWindow: 262144 });
  });

  it('sends attached images inline as base64 ImageContent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-pi-img-'));
    try {
      const img = path.join(dir, 'a.png');
      fs.writeFileSync(img, Buffer.from([1, 2, 3]));
      const child = new FakeChild();
      runPiRpcSession({ child: child as unknown as ChildProcess, prompt: 'hi', imagePaths: [img, path.join(dir, 'x.txt')], emit: () => { /* ignore */ } });
      expect(writes(child)[0]).toMatchObject({ type: 'prompt', images: [{ type: 'image', mimeType: 'image/png', data: 'AQID' }] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads extension-UI dialog fields from the top level of the request', () => {
    const child = new FakeChild();
    const received: unknown[] = [];
    runPiRpcSession({
      child: child as unknown as ChildProcess, prompt: 'hi', emit: () => { /* ignore */ },
      onExtensionUiRequest: (req) => { received.push(req); return true; },
    });
    out(child, { type: 'extension_ui_request', id: 'u1', method: 'select', title: 'Allow?', options: ['Allow', 'Block'] });
    out(child, { type: 'extension_ui_request', id: 'u2', method: 'notify', message: 'fyi' });
    expect(received).toEqual([{ id: 'u1', method: 'select', params: { title: 'Allow?' }, options: ['Allow', 'Block'] }]);
  });

  it('auto-replies to an extension_ui confirm request', () => {
    const child = new FakeChild();
    runPiRpcSession({ child: child as unknown as ChildProcess, prompt: 'hi', model: null, emit: () => { /* ignore */ } });
    out(child, { type: 'extension_ui_request', id: 7, method: 'confirm' });
    const reply = writes(child).find((m) => m['type'] === 'extension_ui_response' && m['id'] === 7);
    expect(reply).toMatchObject({ type: 'extension_ui_response', id: 7, confirmed: true });
  });

  it('forwards extension_ui_request to onExtensionUiRequest and answers via handle.answerExtensionUi', () => {
    const child = new FakeChild();
    const received: Array<{ id: unknown; method: string }> = [];
    const handle = runPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'hi',
      model: null,
      emit: () => { /* ignore */ },
      onExtensionUiRequest: (req) => {
        received.push(req);
        return true;
      },
    });
    out(child, { type: 'extension_ui_request', id: 8, method: 'confirm' });
    // No auto-reply because the callback took ownership.
    const autoReplies = writes(child).filter((m) => m['type'] === 'extension_ui_response');
    expect(autoReplies).toHaveLength(0);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: 8, method: 'confirm' });

    // Caller resolves the request.
    handle.answerExtensionUi(8, { confirmed: true });
    const replies = writes(child).filter((m) => m['type'] === 'extension_ui_response');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ type: 'extension_ui_response', id: 8, confirmed: true });
  });

  it('falls back to auto-reply when onExtensionUiRequest returns false', () => {
    const child = new FakeChild();
    runPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'hi',
      model: null,
      emit: () => { /* ignore */ },
      onExtensionUiRequest: () => false,
    });
    out(child, { type: 'extension_ui_request', id: 9, method: 'confirm' });
    const reply = writes(child).find((m) => m['type'] === 'extension_ui_response' && m['id'] === 9);
    expect(reply).toMatchObject({ type: 'extension_ui_response', id: 9, confirmed: true });
  });

  it('fails when the prompt command is rejected', () => {
    const child = new FakeChild();
    const events: AgentEvent[] = [];
    runPiRpcSession({ child: child as unknown as ChildProcess, prompt: 'hi', model: null, emit: (e) => events.push(e) });
    out(child, { type: 'response', id: 1, success: false, error: 'bad prompt' });
    expect(events).toContainEqual({ type: 'error', message: 'prompt rejected: bad prompt' });
  });
});

describe('mapPiRpcEvent', () => {
  it('maps tool execution start/end', () => {
    const events: AgentEvent[] = [];
    const ctx = { startedAt: 0, firstToken: { value: false } };
    mapPiRpcEvent({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'Bash', args: { command: 'ls' } }, (e) => events.push(e), ctx);
    mapPiRpcEvent({ type: 'tool_execution_end', toolCallId: 't1', result: { content: 'done' }, isError: false }, (e) => events.push(e), ctx);
    expect(events).toEqual([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', toolUseId: 't1', content: 'done', isError: false },
    ]);
  });

  it('returns true only on agent_settled', () => {
    const ctx = { startedAt: 0, firstToken: { value: false } };
    expect(mapPiRpcEvent({ type: 'agent_end' }, () => { /* ignore */ }, ctx)).toBe(false);
    expect(mapPiRpcEvent({ type: 'agent_start' }, () => { /* ignore */ }, ctx)).toBe(false);
    const events: AgentEvent[] = [];
    expect(mapPiRpcEvent({ type: 'agent_settled', aborted: true }, (e) => events.push(e), ctx)).toBe(true);
    expect(events).toEqual([{ type: 'turn_end', stopReason: 'aborted' }]);
  });

  it('restores Devia server ids in pi MCP tool names', () => {
    const events: AgentEvent[] = [];
    const ctx = { startedAt: 0, firstToken: { value: false } };
    mapPiRpcEvent({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'mcp__devia_ui__devia_todo', args: {} }, (e) => events.push(e), ctx);
    expect(events[0]).toMatchObject({ name: 'mcp__devia-ui__devia_todo' });
    expect(normalizePiToolName('mcp__devia_kanban__kanban_list')).toBe('mcp__devia-kanban__kanban_list');
    expect(normalizePiToolName('mcp__github__search')).toBe('mcp__github__search');
    expect(normalizePiToolName('bash')).toBe('bash');
  });

  it('maps a successful compaction to context_compacted', () => {
    const events: AgentEvent[] = [];
    const ctx = { startedAt: 0, firstToken: { value: false } };
    mapPiRpcEvent({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 150000 } }, (e) => events.push(e), ctx);
    expect(events).toEqual([{ type: 'context_compacted', trigger: 'auto', preTokens: 150000 }]);
  });
});

describe('runPiRpcSession — UTF-8 across chunks', () => {
  it('keeps a multi-byte character intact when it straddles two stdout chunks', () => {
    const child = new FakeChild();
    const events: AgentEvent[] = [];
    runPiRpcSession({ child: child as unknown as ChildProcess, prompt: 'hi', model: null, emit: (e) => events.push(e) });
    const line = Buffer.from(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'año 🍎' } })}\n`);
    const cut = line.indexOf(Buffer.from('ñ')) + 1; // inside the 2-byte ñ
    child.stdout.emit('data', line.subarray(0, cut));
    child.stdout.emit('data', line.subarray(cut));
    expect(events).toContainEqual({ type: 'text_delta', delta: 'año 🍎' });
  });
});
