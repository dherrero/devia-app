import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { RunId } from '../../../../shared/domain/agent';
import { answerFilePath, readUiAnswer, writeUiRequest } from '../../../shared/ui-rendezvous';
import { RunInteraction, type RunInteractionContext } from './run-interaction';

/**
 * `devia_spawn_agent` is a blocking UI tool the MAIN process serves itself
 * (S-56): no card, no question timer, and the idle watchdog is kept at bay
 * while the worker runs.
 */
describe('RunInteraction — devia_spawn_agent', () => {
  let uiDir: string;
  let interaction: RunInteraction;
  const handle = { kill: vi.fn(), answer: vi.fn(() => false), keepAlive: vi.fn() };
  const onUiToolRequest = vi.fn();

  const build = (over: Partial<RunInteractionContext> = {}): RunInteraction =>
    new RunInteraction({
      runId: 'run-1' as RunId,
      agentId: 'claude',
      projectName: 'proj-a',
      projectCheckout: '/ws/proj-a',
      cwd: '/ws/proj-a',
      uiDir,
      mode: 'apply',
      isRemote: false,
      advertised: ['todo', 'spawn_agent'],
      timeoutMs: 1_000,
      handlers: { onUiToolRequest },
      spawnWorker: async () => '[pi · implementer · T-1] DONE',
      workerHeartbeatMs: 1_000,
      ...over,
    });

  const request = (callId: string, toolInput: unknown): void =>
    writeUiRequest(uiDir, { callId, tool: 'spawn_agent', toolInput, expectsAnswer: true });
  const answerOf = (callId: string): string | undefined => readUiAnswer(answerFilePath(uiDir, callId))?.answer;
  const tick = async (ms = 100): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-spawn-'));
    handle.kill.mockClear();
    handle.keepAlive.mockClear();
    onUiToolRequest.mockClear();
  });

  afterEach(() => {
    interaction?.stop();
    vi.useRealTimers();
    fs.rmSync(uiDir, { recursive: true, force: true });
  });

  it('runs the worker and writes its report as the tool answer, without drawing a card', async () => {
    const spawnWorker = vi.fn(async () => '[pi · implementer · T-1] DONE');
    interaction = build({ spawnWorker });
    interaction.attach(handle);
    interaction.start();
    request('c1', { role: 'implementer', taskId: 'T-1' });
    await tick();

    expect(spawnWorker).toHaveBeenCalledWith({ role: 'implementer', taskId: 'T-1' });
    expect(answerOf('c1')).toBe('[pi · implementer · T-1] DONE');
    expect(onUiToolRequest).not.toHaveBeenCalled();
  });

  it('calls the worker once even though the request file is seen on many polls', async () => {
    const spawnWorker = vi.fn(() => new Promise<string>(() => undefined));
    interaction = build({ spawnWorker });
    interaction.attach(handle);
    interaction.start();
    request('c1', { role: 'reviewer', taskId: 'T-2' });
    await tick(500);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
  });

  it('never arms the question timer: a long worker does not kill the controller', async () => {
    interaction = build({ spawnWorker: () => new Promise<string>(() => undefined), timeoutMs: 500 });
    interaction.attach(handle);
    interaction.start();
    request('c1', { role: 'implementer', taskId: 'T-1' });
    await tick(10_000);
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it('keeps the idle watchdog at bay while the worker runs, and stops when it ends', async () => {
    let finish: (text: string) => void = () => undefined;
    interaction = build({ spawnWorker: () => new Promise<string>((resolve) => { finish = resolve; }) });
    interaction.attach(handle);
    interaction.start();
    request('c1', { role: 'implementer', taskId: 'T-1' });
    await tick(3_500);
    expect(handle.keepAlive.mock.calls.length).toBeGreaterThanOrEqual(3);

    finish('DONE');
    await tick(100);
    const after = handle.keepAlive.mock.calls.length;
    await tick(5_000);
    expect(handle.keepAlive.mock.calls.length).toBe(after);
  });

  it('answers an unusable request with how to fix it, without starting a worker', async () => {
    const spawnWorker = vi.fn(async () => 'x');
    interaction = build({ spawnWorker });
    interaction.attach(handle);
    interaction.start();
    request('c1', { role: 'architect', taskId: '' });
    await tick();

    expect(spawnWorker).not.toHaveBeenCalled();
    expect(answerOf('c1')).toMatch(/implementer|reviewer/);
  });

  it('turns a worker that throws into a readable answer instead of a hung call', async () => {
    interaction = build({ spawnWorker: async () => { throw new Error('boom'); } });
    interaction.attach(handle);
    interaction.start();
    request('c1', { role: 'implementer', taskId: 'T-1' });
    await tick();
    expect(answerOf('c1')).toContain('boom');
  });

  it('writes no answer once the run has ended (the rendezvous dir is gone)', async () => {
    let finish: (text: string) => void = () => undefined;
    interaction = build({ spawnWorker: () => new Promise<string>((resolve) => { finish = resolve; }) });
    interaction.attach(handle);
    interaction.start();
    request('c1', { role: 'implementer', taskId: 'T-1' });
    await tick();
    interaction.stop();
    fs.rmSync(uiDir, { recursive: true, force: true });
    finish('late');
    await tick();
    expect(fs.existsSync(uiDir)).toBe(false);
  });

  it('is not served when the run was not given the tool or no worker runner', async () => {
    const spawnWorker = vi.fn(async () => 'x');
    interaction = build({ spawnWorker, advertised: ['todo'] });
    interaction.attach(handle);
    interaction.start();
    request('c1', { role: 'implementer', taskId: 'T-1' });
    await tick();
    expect(spawnWorker).not.toHaveBeenCalled();
  });
});

describe('RunInteraction — devia_assign_agents', () => {
  let uiDir: string;
  let interaction: RunInteraction;
  const handle = { kill: vi.fn(), answer: vi.fn(() => false), keepAlive: vi.fn() };
  const onUiToolRequest = vi.fn();
  const question = {
    roles: ['implementer', 'reviewer'] as Array<'implementer' | 'reviewer'>,
    options: [
      { key: 'a', agentId: 'main' },
      { key: 'b', agentId: 'pi' },
    ],
  };

  const build = (assignAgents: RunInteractionContext['assignAgents'], over: Partial<RunInteractionContext> = {}): RunInteraction =>
    new RunInteraction({
      runId: 'run-1' as RunId,
      agentId: 'claude',
      projectName: 'proj-a',
      projectCheckout: '/ws/proj-a',
      cwd: '/ws/proj-a',
      uiDir,
      mode: 'plan',
      isRemote: false,
      advertised: ['todo', 'assign_agents'],
      timeoutMs: 1_000,
      handlers: { onUiToolRequest },
      ...(assignAgents && { assignAgents }),
      ...over,
    });
  const request = (callId: string, toolInput: unknown = {}): void =>
    writeUiRequest(uiDir, { callId, tool: 'assign_agents', toolInput, expectsAnswer: true });
  const answerOf = (callId: string): string | undefined => readUiAnswer(answerFilePath(uiDir, callId))?.answer;
  const tick = async (ms = 100): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-assign-'));
    onUiToolRequest.mockClear();
  });
  afterEach(() => {
    interaction?.stop();
    vi.useRealTimers();
    fs.rmSync(uiDir, { recursive: true, force: true });
  });

  it('answers straight away, with no card, when the project already has the answer', async () => {
    const assign = {
      prepare: vi.fn(async () => ({ kind: 'cached' as const, text: 'Saved for this project: implementer → pi.' })),
      finish: vi.fn(),
    };
    interaction = build(assign);
    interaction.attach(handle);
    interaction.start();
    request('c1', { roles: ['implementer'] });
    await tick();

    expect(assign.prepare).toHaveBeenCalledWith({ roles: ['implementer'], reassign: false });
    expect(answerOf('c1')).toContain('Saved for this project');
    expect(onUiToolRequest).not.toHaveBeenCalled();
  });

  it('draws a card with the question when something is still unanswered, and waits for the user', async () => {
    const assign = {
      prepare: vi.fn(async () => ({ kind: 'ask' as const, question, mainAgentId: 'claude' })),
      finish: vi.fn(async () => 'The user chose: implementer → pi (saved for this project).'),
    };
    interaction = build(assign);
    interaction.attach(handle);
    interaction.start();
    request('c1');
    await tick();

    expect(onUiToolRequest).toHaveBeenCalledTimes(1);
    const [callId, tool, payload, , blocking] = onUiToolRequest.mock.calls[0] as unknown[];
    expect(callId).toBe('c1');
    expect(tool).toBe('assign_agents');
    expect(payload).toMatchObject({ roles: ['implementer', 'reviewer'], mainAgentId: 'claude' });
    expect(blocking).toBe(true);
    expect(answerOf('c1')).toBeUndefined();
  });

  it('turns the card answer into the saved result the agent reads', async () => {
    const assign = {
      prepare: vi.fn(async () => ({ kind: 'ask' as const, question, mainAgentId: 'claude' })),
      finish: vi.fn(async () => 'The user chose: implementer → pi (saved for this project).'),
    };
    interaction = build(assign);
    interaction.attach(handle);
    interaction.start();
    request('c1');
    await tick();

    interaction.answer('c1', '1. b\n2. a');
    await tick();
    expect(assign.finish).toHaveBeenCalledWith(question, '1. b\n2. a');
    expect(answerOf('c1')).toContain('saved for this project');
  });

  it('calls prepare once even though the request is seen on many polls', async () => {
    const assign = { prepare: vi.fn(async () => ({ kind: 'ask' as const, question, mainAgentId: 'claude' })), finish: vi.fn() };
    interaction = build(assign);
    interaction.attach(handle);
    interaction.start();
    request('c1');
    await tick(500);
    expect(assign.prepare).toHaveBeenCalledTimes(1);
  });

  it('is not served without the capability, or when the run was not given the tool', async () => {
    const assign = { prepare: vi.fn(), finish: vi.fn() };
    interaction = build(assign, { advertised: ['todo'] });
    interaction.attach(handle);
    interaction.start();
    request('c1');
    await tick();
    expect(assign.prepare).not.toHaveBeenCalled();
  });

  it('answers with an explanation when preparing fails, instead of hanging', async () => {
    const assign = { prepare: vi.fn(async () => { throw new Error('detector down'); }), finish: vi.fn() };
    interaction = build(assign);
    interaction.attach(handle);
    interaction.start();
    request('c1');
    await tick();
    expect(answerOf('c1')).toContain('detector down');
  });
});
