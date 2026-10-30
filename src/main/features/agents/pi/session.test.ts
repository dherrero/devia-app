import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { AgentSessionIo, AgentUiRequest } from '../domain';
import { makeRunPlan } from '../testing/make-run-plan';
import { openPiSession } from './session';

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

function open(requestUi: (r: AgentUiRequest) => boolean) {
  const child = new FakeChild();
  const io: AgentSessionIo = {
    process: child as unknown as ChildProcess,
    stdin: child.stdin as unknown as Writable,
    stdout: child.stdout as unknown as Readable,
    emit: () => undefined,
    requestUi,
  };
  const session = openPiSession(io, makeRunPlan({ agentId: 'pi', prompt: 'hi' }));
  const out = (obj: unknown): void => { child.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`)); };
  const responses = (): Array<Record<string, unknown>> => child.stdin.writes
    .flatMap((w) => w.split('\n')).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((m) => m['type'] === 'extension_ui_response');
  return { session, out, responses };
}

describe('pi session — native dialogs in Devia terms', () => {
  it('raises a pi confirm as a canonical confirm and answers it on pi wire', () => {
    const requestUi = vi.fn((_request: AgentUiRequest) => true);
    const { session, out, responses } = open(requestUi);
    out({ type: 'extension_ui_request', id: 7, method: 'confirm', title: 'Clear session?', message: 'All messages will be lost.' });
    expect(requestUi).toHaveBeenCalledWith({
      callId: '7', kind: 'confirm', purpose: 'question', title: 'Clear session?', message: 'All messages will be lost.',
    });
    expect(session.answer('7', { kind: 'confirm', confirmed: false })).toBe(true);
    expect(responses()).toEqual([{ type: 'extension_ui_response', id: 7, confirmed: false }]);
  });

  it('raises a pi select with its options and returns the chosen value', () => {
    const requestUi = vi.fn((_request: AgentUiRequest) => true);
    const { session, out, responses } = open(requestUi);
    out({ type: 'extension_ui_request', id: 'u1', method: 'select', title: 'Allow?', options: ['Allow', 'Block'] });
    expect(requestUi.mock.calls[0]?.[0]).toMatchObject({ kind: 'select', title: 'Allow?', options: [{ id: '0', label: 'Allow' }, { id: '1', label: 'Block' }] });
    session.answer('u1', { kind: 'select', value: 'Block' });
    expect(responses()).toEqual([{ type: 'extension_ui_response', id: 'u1', value: 'Block' }]);
  });

  it('sends a cancel as pi cancelled', () => {
    const { session, out, responses } = open(() => true);
    out({ type: 'extension_ui_request', id: 'i1', method: 'input', title: 'Name?' });
    session.answer('i1', { kind: 'cancel' });
    expect(responses()).toEqual([{ type: 'extension_ui_response', id: 'i1', cancelled: true }]);
  });

  it('falls back to pi auto-reply when nothing can draw the card', () => {
    const { session, out, responses } = open(() => false);
    out({ type: 'extension_ui_request', id: 9, method: 'confirm', title: 'Go?' });
    expect(responses()).toEqual([{ type: 'extension_ui_response', id: 9, confirmed: true }]);
    expect(session.answer('9', { kind: 'confirm', confirmed: false })).toBe(false);
  });

  it('ignores an answer for a call it never raised', () => {
    const { session } = open(() => true);
    expect(session.answer('nope', { kind: 'text', text: 'x' })).toBe(false);
  });
});
