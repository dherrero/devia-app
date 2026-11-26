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
import { ConfigChangeBus } from '../../../shared/config-change-bus';
import type { DeviaConfig } from '../../../../shared/domain/config';
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

function setup(
  autoContinue: Record<string, boolean> = {},
  opts: { globalAgentId?: string; effective?: (project: string, sessionId?: string) => string } = {},
) {
  const handles = new Map<string, (...args: unknown[]) => unknown>();
  const send = vi.fn();
  const ctx = {
    ipc: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handles.set(channel, fn) },
    send,
    getMainWindow: () => null,
  } as unknown as FeatureContext;

  const captured: RunInstructionHandlers[] = [];
  const executeCalls: unknown[][] = [];
  const gateway = new RunGateway();
  const events: RunGatewayEvent[] = [];
  gateway.subscribe((e) => events.push(e));

  const dispatchNext = vi.fn();
  const writeToolResult = vi.fn();
  const configChanges = new ConfigChangeBus();
  const deps = {
    runInstruction: {
      execute: (...args: unknown[]) => {
        executeCalls.push(args);
        captured.push(args[3] as RunInstructionHandlers);
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
    registry: { writeToolResult },
    config: { get: () => ({ agentId: opts.globalAgentId ?? 'claude', autoContinueSessions: autoContinue }) },
    ...(opts.effective && {
      effectiveAgent: {
        forRun: (p: string, sid?: string) => ({ agentId: opts.effective!(p, sid), source: 'project' as const }),
      },
    }),
    auditLog: { append: vi.fn(), readLast: () => [] },
    runGateway: gateway,
    configChanges,
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
  return { start, send, fileEvents, events, ipc, handles, dispatchNext, configChanges, captured, gateway, executeCalls, writeToolResult };
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

  const cfgWith = (autoContinueSessions: Record<string, boolean>) =>
    ({ agentId: 'claude', autoContinueSessions }) as unknown as DeviaConfig;

  it('turning the switch off cancels every pending resume of that agent and frees its queue', () => {
    const t = setup({ claude: true, other: true });
    t.start('proj-a').onRateLimited!({ runId: RUN_ID, agentId: 'claude', resetsAt: inAMinute() });
    t.start('proj-b').onRateLimited!({ runId: RUN_ID, agentId: 'claude', resetsAt: inAMinute() });
    t.start('proj-c').onRateLimited!({ runId: RUN_ID, agentId: 'other', resetsAt: inAMinute() });
    t.configChanges.publish(cfgWith({ claude: false, other: true }));
    expect(t.send).toHaveBeenCalledWith('autoresume:cancelled', { project: 'proj-a', reason: 'disabled' });
    expect(t.send).toHaveBeenCalledWith('autoresume:cancelled', { project: 'proj-b', reason: 'disabled' });
    expect(t.send).not.toHaveBeenCalledWith('autoresume:cancelled', expect.objectContaining({ project: 'proj-c' }));
    expect(t.dispatchNext).toHaveBeenCalledWith('proj-a');
    expect(t.dispatchNext).toHaveBeenCalledWith('proj-b');
    expect(t.dispatchNext).not.toHaveBeenCalledWith('proj-c');
    t.ipc.dispose();
  });

  it('a config saved with the switch unchanged cancels nothing', () => {
    const t = setup({ claude: true });
    t.start('proj-a').onRateLimited!({ runId: RUN_ID, agentId: 'claude', resetsAt: inAMinute() });
    t.configChanges.publish(cfgWith({ claude: true }));
    expect(t.send).not.toHaveBeenCalledWith('autoresume:cancelled', expect.anything());
    t.ipc.dispose();
  });

  it('stops listening after dispose', () => {
    const t = setup({ claude: true });
    t.start('proj-a').onRateLimited!({ runId: RUN_ID, agentId: 'claude', resetsAt: inAMinute() });
    t.ipc.dispose();
    t.configChanges.publish(cfgWith({ claude: false }));
    expect(t.send).not.toHaveBeenCalledWith('autoresume:cancelled', expect.anything());
  });
});

describe('claude.ipc — auto-continue follows the effective agent (S-53)', () => {
  const rateLimit = (t: ReturnType<typeof setup>, project: string) =>
    t.start(project).onRateLimited!({ runId: RUN_ID, agentId: 'claude', resetsAt: Date.now() + 60_000 });

  it('resumes when the PROJECT agent is still the one that was rate-limited, even if the global agent differs', () => {
    vi.useFakeTimers();
    try {
      const t = setup({ claude: true }, { globalAgentId: 'codex', effective: () => 'claude' });
      rateLimit(t, 'proj-a');
      vi.advanceTimersByTime(10 * 60_000);
      expect(t.captured).toHaveLength(2); // the original run + the automatic continue
      t.ipc.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resume when the project switched to another agent while waiting, even if the global agent matches', () => {
    vi.useFakeTimers();
    try {
      const t = setup({ claude: true }, { globalAgentId: 'claude', effective: () => 'codex' });
      rateLimit(t, 'proj-a');
      vi.advanceTimersByTime(10 * 60_000);
      expect(t.captured).toHaveLength(1);
      expect(t.dispatchNext).toHaveBeenCalledWith('proj-a');
      t.ipc.dispose();
    } finally {
      vi.useRealTimers();
    }
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

describe('claude.ipc — gateway submit with its own run identity (S-56)', () => {
  it('starts the run under the given run key, session, isolation and agent', () => {
    const t = setup();
    const runKey = 'devia-worker:proj-a:T-1:1';
    t.gateway.submit('proj-a', 'implement T-1', {
      mode: 'apply-yolo',
      origin: 'renderer',
      runKey,
      sessionId: 'worker-session-1',
      isolate: true,
      agentIdOverride: 'pi',
    });

    const call = t.executeCalls[0] as unknown[];
    expect(call[0]).toBe('proj-a');
    expect(call[4]).toBe('apply-yolo');
    expect(call[6]).toBe('renderer');
    expect(call.slice(7, 11)).toEqual([true, runKey, 'worker-session-1', 'pi']);

    // Events of that run reach the gateway under the run key, so a completion
    // waiter keyed by it sees them and nobody else's.
    const handlers = t.captured[0] as RunInstructionHandlers;
    handlers.onProcessStart({ runId: RUN_ID, agentId: 'pi' });
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'start', project: runKey }));
    t.ipc.dispose();
  });

  it('a plain submit keeps the old behaviour: no run key, no isolation, no override', () => {
    const t = setup();
    t.gateway.submit('proj-a', 'hello', { mode: 'apply', origin: 'remote' });
    const call = t.executeCalls[0] as unknown[];
    expect(call.slice(7, 11)).toEqual([false, undefined, undefined, undefined]);
    t.ipc.dispose();
  });
});

describe('claude.ipc — remote assignment question (S-56 T12)', () => {
  const QUESTION = {
    roles: ['implementer'] as Array<'implementer'>,
    options: [{ key: 'a', agentId: 'main' }, { key: 'b', agentId: 'pi' }],
  };

  it('publishes the question on the gateway under the run identity, for the relay to ask as text', () => {
    const t = setup();
    const handlers = t.start('proj-a');
    handlers.onRemoteAssign?.('call-1', { question: QUESTION, mainAgentId: 'claude' }, RUN_ID);
    expect(t.events).toContainEqual({
      type: 'ask',
      project: 'proj-a',
      runId: RUN_ID,
      callId: 'call-1',
      question: QUESTION,
      mainAgentId: 'claude',
    });
    t.ipc.dispose();
  });

  it('routes the relay\'s answer to the blocked tool call, sanitised', () => {
    const t = setup();
    t.start('proj-a');
    expect(t.gateway.answerTool('proj-a', 'call-1', '1. b\0')).toBe(true);
    expect(t.writeToolResult).toHaveBeenCalledWith('proj-a', 'call-1', '1. b');
    t.ipc.dispose();
  });
});
