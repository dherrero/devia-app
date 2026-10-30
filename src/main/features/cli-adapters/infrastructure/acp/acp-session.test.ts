/**
 * Tests for the ACP session driver: the JSON-RPC handshake
 * (initialize → session/new → session/prompt), session/update → AgentEvent
 * mapping, permission auto-approval, and usage/turn_end on completion.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { runAcpSession, choosePermissionOutcome } from './acp-session';
import type { AgentEvent } from '../../../../../shared/domain/agent-event';

class FakeStdin {
  writes: string[] = [];
  writable = true;
  destroyed = false;
  writableEnded = false;
  write(s: string): boolean { this.writes.push(s); return true; }
  end(): void { this.writableEnded = true; }
  on(): this { return this; }
}

class FakeChild extends EventEmitter {
  killed = false;
  stdin = new FakeStdin();
  stdout = new EventEmitter();
  kill(): boolean { this.killed = true; return true; }
}

/** Parse the JSON-RPC messages the driver wrote to stdin. */
function rpcWrites(child: FakeChild): Array<Record<string, unknown>> {
  return child.stdin.writes
    .join('')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
function lastWrite(child: FakeChild): Record<string, unknown> {
  const all = rpcWrites(child);
  const last = all[all.length - 1];
  if (!last) throw new Error('no JSON-RPC writes captured');
  return last;
}
function respond(child: FakeChild, id: number, result: unknown): void {
  child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function notify(child: FakeChild, method: string, params: unknown): void {
  child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

describe('runAcpSession — JSON-RPC handshake', () => {
  it('drives initialize → session/new → session/prompt and streams updates', () => {
    const child = new FakeChild();
    const events: AgentEvent[] = [];
    runAcpSession({
      child: child as unknown as ChildProcess,
      prompt: 'hi there',
      cwd: '/proj',
      model: null,
      emit: (e) => events.push(e),
    });

    // initialize sent immediately
    expect(lastWrite(child)).toMatchObject({ id: 1, method: 'initialize' });

    // initialize result → session/new
    respond(child, 1, {});
    expect(lastWrite(child)).toMatchObject({ id: 2, method: 'session/new' });
    expect((lastWrite(child).params as Record<string, unknown>)['cwd']).toBeDefined();

    // session/new result → session/prompt (no model)
    respond(child, 2, { sessionId: 's1' });
    expect(events).toContainEqual({ type: 'session_started', agentSessionId: 's1' });
    const prompt = lastWrite(child);
    expect(prompt).toMatchObject({ id: 3, method: 'session/prompt' });
    expect((prompt.params as Record<string, unknown>)['sessionId']).toBe('s1');

    // streamed assistant text
    notify(child, 'session/update', { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Hello' } } });
    expect(events.some((e) => e.type === 'status' && e.label === 'streaming')).toBe(true);
    expect(events).toContainEqual({ type: 'text_delta', delta: 'Hello' });

    // prompt result → usage + turn_end
    respond(child, 3, { usage: { inputTokens: 5, outputTokens: 3 } });
    expect(events).toContainEqual({ type: 'usage', inputTokens: 5, outputTokens: 3 });
    expect(events).toContainEqual({ type: 'turn_end', stopReason: 'completed' });
  });

  it('sends session/set_model when a non-default model is requested', () => {
    const child = new FakeChild();
    runAcpSession({ child: child as unknown as ChildProcess, prompt: 'hi', cwd: '/p', model: 'kimi-k2', emit: () => { /* ignore */ } });
    respond(child, 1, {});
    respond(child, 2, { sessionId: 's1' });
    expect(lastWrite(child)).toMatchObject({ id: 3, method: 'session/set_model' });
    expect((lastWrite(child).params as Record<string, unknown>)['modelId']).toBe('kimi-k2');
    respond(child, 3, {});
    expect(lastWrite(child)).toMatchObject({ method: 'session/prompt' });
  });

  it('surfaces permission requests (no auto-reply) and replies with the chosen option', () => {
    const child = new FakeChild();
    const perms: Array<{ id: string; title: string; options: Array<{ optionId: string; label: string }> }> = [];
    const session = runAcpSession({
      child: child as unknown as ChildProcess, prompt: 'hi', cwd: '/p', model: null, emit: () => { /* ignore */ },
      onPermissionRequest: (r) => perms.push(r),
    });
    respond(child, 1, {});
    respond(child, 2, { sessionId: 's1' });
    child.stdout.emit('data', `${JSON.stringify({
      jsonrpc: '2.0', id: 55, method: 'session/request_permission',
      params: { title: 'Run rm -rf?', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Reject', kind: 'reject_once' }] },
    })}\n`);

    // Not auto-replied: surfaced to the handler instead.
    expect(rpcWrites(child).find((m) => m['id'] === 55)).toBeUndefined();
    expect(perms).toHaveLength(1);
    expect(perms[0]).toMatchObject({ id: '55', title: 'Run rm -rf?' });
    expect(perms[0]?.options).toEqual([{ optionId: 'allow', label: 'Allow' }, { optionId: 'deny', label: 'Reject' }]);

    // Answer with the chosen label → reply with that optionId.
    session.answerPermission('55', 'Allow');
    expect(rpcWrites(child).find((m) => m['id'] === 55)?.['result']).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  it('auto-approves permission requests with an allow option', () => {
    const child = new FakeChild();
    runAcpSession({ child: child as unknown as ChildProcess, prompt: 'hi', cwd: '/p', model: null, emit: () => { /* ignore */ } });
    respond(child, 1, {});
    respond(child, 2, { sessionId: 's1' });
    child.stdout.emit('data', `${JSON.stringify({
      jsonrpc: '2.0', id: 99, method: 'session/request_permission',
      params: { options: [{ optionId: 'deny', kind: 'reject_once' }, { optionId: 'ok', kind: 'allow_once' }] },
    })}\n`);
    const reply = rpcWrites(child).find((m) => m['id'] === 99);
    expect(reply).toBeDefined();
    expect(reply?.['result']).toEqual({ outcome: { outcome: 'selected', optionId: 'ok' } });
  });
});

describe('choosePermissionOutcome', () => {
  it('prefers approve_for_session, then allow_always, then allow_once', () => {
    expect(choosePermissionOutcome([{ optionId: 'approve_for_session' }, { optionId: 'x', kind: 'allow_once' }])).toBe('approve_for_session');
    expect(choosePermissionOutcome([{ optionId: 'aa', kind: 'allow_always' }, { optionId: 'ao', kind: 'allow_once' }])).toBe('aa');
    expect(choosePermissionOutcome([{ optionId: 'ao', kind: 'allow_once' }])).toBe('ao');
    expect(choosePermissionOutcome([{ optionId: 'no', kind: 'reject_once' }])).toBeNull();
  });
});
