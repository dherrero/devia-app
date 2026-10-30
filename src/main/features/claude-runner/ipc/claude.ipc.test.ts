import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
    on(): void { /* unused */ }
    show(): void { /* unused */ }
  },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}));

import { IPC } from '../../../../shared/contracts/ipc-channels';
import type { RunId } from '../../../../shared/domain/agent';
import type { FeatureContext } from '../../../shared/feature';
import { RunGateway, type RunFile, type RunGatewayEvent } from '../../../shared/run-gateway';
import type { RunInstructionHandlers } from '../application/run-instruction.use-case';
import { registerClaudeRunnerIpc, type ClaudeRunnerIpcDeps } from './claude.ipc';

const RUN_ID = 'run-1' as RunId;

const FILE: RunFile = {
  path: '/ws/proj-a/report.pdf',
  name: 'report.pdf',
  size: 4,
  mime: 'application/pdf',
  kind: 'document',
  source: 'tool',
};

function setup(autoContinue: Record<string, boolean> = {}) {
  const handles = new Map<string, (...args: unknown[]) => unknown>();
  const send = vi.fn();
  const ctx = {
    ipc: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handles.set(channel, fn) },
    send,
    getMainWindow: () => null,
  } as unknown as FeatureContext;

  const captured: RunInstructionHandlers[] = [];
  const gateway = new RunGateway();
  const events: RunGatewayEvent[] = [];
  gateway.subscribe((e) => events.push(e));

  const dispatchNext = vi.fn();
  const deps = {
    runInstruction: {
      execute: (_p: string, _t: string, _a: unknown, handlers: RunInstructionHandlers) => {
        captured.push(handlers);
      },
    },
    stopProject: { execute: vi.fn() },
    stopAll: { execute: vi.fn(() => []) },
    resetSession: { execute: vi.fn() },
    attachments: {},
    queue: {
      attachDispatcher: vi.fn(),
      shouldEnqueue: () => false,
      dispatchNext,
      clear: vi.fn(),
    },
    registry: {},
    config: { get: () => ({ agentId: 'claude', autoContinueSessions: autoContinue }) },
    auditLog: { append: vi.fn(), readLast: () => [] },
    runGateway: gateway,
  } as unknown as ClaudeRunnerIpcDeps;

  const ipc = registerClaudeRunnerIpc(ctx, deps);

  /** Start a run the way the renderer does, and return its handlers. */
  const start = (project: string, runKey?: string): RunInstructionHandlers => {
    handles.get(IPC.instructionSend)!(
      {}, project, 'go', [], 'apply', undefined, runKey !== undefined ? { runKey } : undefined,
    );
    return captured[captured.length - 1]!;
  };
  const fileEvents = () => events.filter((e) => e.type === 'file');
  return { start, send, fileEvents, events, ipc, handles, dispatchNext };
}

describe('claude.ipc — auto-continue after the usage limit', () => {
  const inAMinute = () => Date.now() + 60_000;

  it('schedules a resume and tells the renderer when the switch is on', () => {
    const t = setup({ claude: true });
    const handlers = t.start('proj-a');
    handlers.onRateLimited!({ runId: RUN_ID, agentId: 'claude', resetsAt: inAMinute() });
    expect(t.send).toHaveBeenCalledWith('autoresume:scheduled', expect.objectContaining({ project: 'proj-a' }));
    t.ipc.dispose();
  });

  it('does nothing when the switch is off', () => {
    const t = setup({});
    const handlers = t.start('proj-a');
    handlers.onRateLimited!({ runId: RUN_ID, agentId: 'claude', resetsAt: inAMinute() });
    expect(t.send).not.toHaveBeenCalledWith('autoresume:scheduled', expect.anything());
    t.ipc.dispose();
  });

  it('does nothing without a reset time', () => {
    const t = setup({ claude: true });
    const handlers = t.start('proj-a');
    handlers.onRateLimited!({ runId: RUN_ID, agentId: 'claude' });
    expect(t.send).not.toHaveBeenCalledWith('autoresume:scheduled', expect.anything());
    t.ipc.dispose();
  });

  it('keeps the parked queue parked while a resume is pending', () => {
    const t = setup({ claude: true });
    const handlers = t.start('proj-a');
    handlers.onRateLimited!({ runId: RUN_ID, agentId: 'claude', resetsAt: inAMinute() });
    handlers.onProcessEnd({ runId: RUN_ID, code: 1, error: 'limit' });
    expect(t.dispatchNext).not.toHaveBeenCalled();
    t.ipc.dispose();
  });

  it('cancels the pending resume when the user cancels it', () => {
    const t = setup({ claude: true });
    const handlers = t.start('proj-a');
    handlers.onRateLimited!({ runId: RUN_ID, agentId: 'claude', resetsAt: inAMinute() });
    t.handles.get(IPC.autoResumeCancel)!({}, 'proj-a');
    expect(t.send).toHaveBeenCalledWith('autoresume:cancelled', { project: 'proj-a', reason: 'user' });
    t.ipc.dispose();
  });

  it('a new message from the user cancels it too', () => {
    const t = setup({ claude: true });
    const handlers = t.start('proj-a');
    handlers.onRateLimited!({ runId: RUN_ID, agentId: 'claude', resetsAt: inAMinute() });
    t.start('proj-a');
    expect(t.send).toHaveBeenCalledWith('autoresume:cancelled', { project: 'proj-a', reason: 'user' });
    t.ipc.dispose();
  });
});

describe('claude.ipc — devia_send_file (S-32)', () => {
  it('publishes a `file` event with the run identity and still draws the card', () => {
    const { start, send, fileEvents } = setup();
    start('proj-a').onUiToolRequest!('s-1', 'send_file', FILE, RUN_ID, false);

    expect(fileEvents()).toEqual([{ type: 'file', project: 'proj-a', runId: RUN_ID, file: FILE }]);
    expect(send).toHaveBeenCalledWith('ui:tool-request', {
      project: 'proj-a', runId: RUN_ID, callId: 's-1', tool: 'send_file', input: FILE, expectsAnswer: false,
    });
  });

  it('a split pane publishes under its session identity, like start/output/end', () => {
    const { start, fileEvents } = setup();
    start('proj-a', 'sess-42').onUiToolRequest!('s-1', 'send_file', FILE, RUN_ID, false);

    expect(fileEvents()[0]).toMatchObject({ project: 'sess-42' });
  });

  it('publishes nothing for a payload the runner did not revalidate', () => {
    const { start, send, fileEvents } = setup();
    start('proj-a').onUiToolRequest!('s-1', 'send_file', { path: 'report.pdf', as: 'auto' }, RUN_ID, false);

    expect(fileEvents()).toEqual([]);
    expect(send).not.toHaveBeenCalledWith('ui:tool-request', expect.anything());
  });

  it('forwards the admission identity untouched', () => {
    const { start, fileEvents } = setup();
    const withIdentity: RunFile = { ...FILE, identity: { dev: 16777220, ino: 4242 } };
    start('proj-a').onUiToolRequest!('s-1', 'send_file', withIdentity, RUN_ID, false);

    expect(fileEvents()[0]).toMatchObject({ file: { identity: { dev: 16777220, ino: 4242 } } });
  });

  it('refuses a payload with a malformed identity', () => {
    const { start, fileEvents } = setup();
    start('proj-a').onUiToolRequest!('s-1', 'send_file', { ...FILE, identity: { dev: '1', ino: 2 } }, RUN_ID, false);

    expect(fileEvents()).toEqual([]);
  });

  it('other tools never publish a file', () => {
    const { start, fileEvents } = setup();
    start('proj-a').onUiToolRequest!('t-1', 'todo', { items: [] }, RUN_ID, false);

    expect(fileEvents()).toEqual([]);
  });
});

describe('claude.ipc — outbox fallback (S-32 T-367)', () => {
  const OUTBOX_FILE: RunFile = { ...FILE, path: '/devia/outbox-archive/1_report.pdf', source: 'outbox' };

  it('publishes an outbox RunFile under the session identity', () => {
    const { start, fileEvents } = setup();
    start('proj-a', 'sess-42').onRunFile!(OUTBOX_FILE, RUN_ID);

    expect(fileEvents()).toEqual([{ type: 'file', project: 'sess-42', runId: RUN_ID, file: OUTBOX_FILE }]);
  });

  it('publishes a rejection with the name only', () => {
    const { start, events } = setup();
    start('proj-a').onRunFileRejected!({ name: '.env', reason: 'secret', source: 'outbox' }, RUN_ID);

    expect(events.filter((e) => e.type === 'file_rejected')).toEqual([
      { type: 'file_rejected', project: 'proj-a', runId: RUN_ID, name: '.env', reason: 'secret', source: 'outbox' },
    ]);
  });

  it('routes the renderer outbox card by session identity', () => {
    const { start, send } = setup();
    start('proj-a', 'sess-42').onOutboxFile({
      project: 'proj-a', name: 'a.txt', kind: 'file', path: '/devia/outbox-archive/1_a.txt', size: 1, mime: 'text/plain',
    });

    expect(send).toHaveBeenCalledWith('outbox:file', expect.objectContaining({ project: 'sess-42', name: 'a.txt' }));
  });
});

describe('claude.ipc — run end on the gateway', () => {
  it('publishes the cancelReason of a user stop', () => {
    const { start, events } = setup();
    start('proj-a').onProcessEnd({ runId: RUN_ID, code: 1, error: 'Cancelado por ti.', cancelReason: 'user' });

    expect(events.filter((e) => e.type === 'end')).toEqual([
      { type: 'end', project: 'proj-a', runId: RUN_ID, code: 1, error: 'Cancelado por ti.', cancelReason: 'user' },
    ]);
  });

  it('omits cancelReason when the run was not cancelled', () => {
    const { start, events } = setup();
    start('proj-a').onProcessEnd({ runId: RUN_ID, code: 0 });

    expect(events.filter((e) => e.type === 'end')).toEqual([{ type: 'end', project: 'proj-a', runId: RUN_ID, code: 0 }]);
  });
});
