import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/contracts/ipc-channels';
import type { FeatureContext } from '../../shared/feature';
import { buildCrossAgentFeature, type CrossAgentBuildDeps } from './index';
import { RunGateway } from '../../shared/run-gateway';
import { DEFAULT_CROSS_AGENT_CONFIG } from '../../../shared/domain/cross-agent-config';
import type { RunId } from '../../../shared/domain/agent';
import type { DetectedAgentLike } from './application/resolve-worker-agent';
import type { GitResult, GitRunner } from './infrastructure/git-runner';

const agent = (id: string, over: Partial<DetectedAgentLike> = {}): DetectedAgentLike => ({
  id,
  available: true,
  providerType: 'cli',
  authStatus: 'ok',
  ...over,
});

function setup(over: { detected?: DetectedAgentLike[]; roleAgents?: Record<string, string>; enabled?: boolean } = {}) {
  const gateway = new RunGateway();
  const submitted: Array<{ project: string; text: string; runKey?: string }> = [];
  // A fake runner: starting a run publishes its stream through the gateway, like the real one does.
  gateway.bindSubmit((project, text, opts) => {
    submitted.push({ project, text, ...(opts?.runKey !== undefined && { runKey: opts.runKey }) });
    const key = opts?.runKey ?? project;
    queueMicrotask(() => {
      gateway.publish({ type: 'start', project: key, runId: 'r1' as RunId, agentId: opts?.agentIdOverride ?? 'x' });
      gateway.publish({
        type: 'output',
        project: key,
        runId: 'r1' as RunId,
        line: JSON.stringify({ type: 'text_delta', delta: 'STATUS: DONE\nBuilt it.\ncommit abc1234' }),
      });
      gateway.publish({ type: 'end', project: key, runId: 'r1' as RunId, code: 0 });
    });
    return { queued: false };
  });
  const stop = vi.fn((_runKey: string) => true);
  const gitCalls: string[][] = [];
  const git: GitRunner = {
    run: (_cwd, args): GitResult => {
      gitCalls.push([...args]);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { ok: true, stdout: 'deadbeef', stderr: '' };
      if (args[0] === 'status') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return { ok: true, stdout: 'x', stderr: '' };
      if (args[0] === 'log') return { ok: true, stdout: 'abc1234', stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    },
  };
  const record: { roleAgents: Record<string, string> } = { roleAgents: over.roleAgents ?? {} };
  const stateSave = vi.fn();
  const deps: CrossAgentBuildDeps = {
    config: {
      get: () => ({ crossAgent: { ...DEFAULT_CROSS_AGENT_CONFIG, enabled: over.enabled ?? true }, workspaceRoot: '/ws', agentId: 'claude' }),
      deviaDir: () => '/dv',
    } as never,
    registry: { find: () => record as never, getOrCreate: () => record as never },
    agents: { get: () => ({ providerType: 'cli' }) },
    state: { save: stateSave } as never,
    effective: { forRun: () => ({ agentId: 'claude', source: 'global' as const }) },
    detector: {
      detectOne: async (id) => (over.detected ?? [agent('claude'), agent('pi')]).find((a) => a.id === id) ?? null,
      detectAll: async () => over.detected ?? [agent('claude'), agent('pi')],
    },
    gateway,
    stopRun: stop,
    git,
    ensureWorktree: () => ({ ok: true, created: true }),
    projectDir: (project) => `/ws/${project}`,
  };
  const built = buildCrossAgentFeature(deps);
  return { built, submitted, stop, gitCalls, gateway, record, stateSave };
}

const CALL = {
  project: 'proj-a',
  parentKey: 'proj-a',
  turnId: 'turn-1',
  role: 'implementer' as const,
  taskId: 'T-1',
  mode: 'apply' as const,
  controllerCwd: '/ws/proj-a',
};

describe('buildCrossAgentFeature', () => {
  it('runs a worker end to end through the gateway and returns the rendered report', async () => {
    const t = setup({ roleAgents: { implementer: 'pi' } });
    const text = await t.built.spawnWorker(CALL);
    expect(text).toContain('pi');
    expect(text).toContain('DONE');
    expect(t.submitted).toHaveLength(1);
    expect(t.submitted[0]?.runKey).toMatch(/^devia-worker:proj-a:T-1:/);
    expect(t.submitted[0]?.project).toBe('proj-a');
    // not split reviewer role → integrated right away with a ff-only merge
    expect(t.gitCalls.some((a) => a[0] === 'merge' && a.includes('--ff-only'))).toBe(true);
  });

  it('an explicit main reviewer is not a split: the implementer is integrated right away', async () => {
    const t = setup({ roleAgents: { implementer: 'pi', reviewer: 'main' } });
    await t.built.spawnWorker(CALL);
    expect(t.gitCalls.some((a) => a[0] === 'merge' && a.includes('--ff-only'))).toBe(true);
  });

  it('refuses without launching when the feature is off', async () => {
    const t = setup({ enabled: false });
    const text = await t.built.spawnWorker(CALL);
    expect(text).toMatch(/turned off/i);
    expect(t.submitted).toHaveLength(0);
  });

  it('blocks, with the reason, when the mapped agent is not installed', async () => {
    const t = setup({ roleAgents: { implementer: 'pi' }, detected: [agent('claude'), agent('pi', { available: false })] });
    const text = await t.built.spawnWorker(CALL);
    expect(text).toMatch(/not installed/i);
    expect(t.submitted).toHaveLength(0);
  });

  it('counts usable agents from the last scan, so execute() can decide synchronously', async () => {
    const t = setup({ detected: [agent('claude'), agent('pi'), agent('codex', { available: false })] });
    expect(t.built.usableAgentCount()).toBe(0); // nothing scanned yet
    await t.built.refreshAgents();
    expect(t.built.usableAgentCount()).toBe(2);
  });

  it('cancels the workers of a controller and stops their runs', async () => {
    const t = setup({ roleAgents: { implementer: 'pi' } });
    // hold the worker: its run never ends
    t.gateway.bindSubmit(() => ({ queued: false }));
    const pending = t.built.spawnWorker(CALL);
    await new Promise((r) => setImmediate(r));
    expect(t.built.cancelWorkers('proj-a')).toBe(1);
    expect(t.stop).toHaveBeenCalledWith(expect.stringMatching(/^devia-worker:proj-a:T-1:/));
    // the run was killed: the gateway reports its end as cancelled
    t.gateway.publish({ type: 'end', project: t.stop.mock.calls[0]?.[0] as string, code: null, cancelReason: 'user' });
    await expect(pending).resolves.toMatch(/cancel/i);
  });
});

describe('buildCrossAgentFeature — assignAgents (S-56 T9)', () => {
  it('asks about the roles the project has not answered, offering the usable agents', async () => {
    const t = setup({ detected: [agent('claude'), agent('pi'), agent('codex', { available: false })] });
    const prepared = await t.built.assignAgents.prepare('proj-a', { roles: ['implementer', 'reviewer'], reassign: false });
    expect(prepared.kind).toBe('ask');
    if (prepared.kind !== 'ask') return;
    expect(prepared.question.options.map((o) => o.agentId)).toEqual(['main', 'pi']);
    expect(prepared.mainAgentId).toBe('claude');
  });

  it('saves the answer on the project and persists the state', async () => {
    const t = setup();
    const prepared = await t.built.assignAgents.prepare('proj-a', { roles: ['implementer', 'reviewer'], reassign: false });
    if (prepared.kind !== 'ask') throw new Error('expected a question');
    const text = await t.built.assignAgents.finish('proj-a', prepared.question, '1. b\n2. a');
    expect(t.record.roleAgents).toEqual({ implementer: 'pi', reviewer: 'main' });
    expect(t.stateSave).toHaveBeenCalled();
    expect(text).toContain('implementer → pi');
  });

  it('does not ask again once saved', async () => {
    const t = setup({ roleAgents: { implementer: 'pi', reviewer: 'main' } });
    const prepared = await t.built.assignAgents.prepare('proj-a', { roles: ['implementer', 'reviewer'], reassign: false });
    expect(prepared.kind).toBe('cached');
  });
});

describe('buildCrossAgentFeature — renderer surface (S-56 T10)', () => {
  function register(t: ReturnType<typeof setup>) {
    const handles = new Map<string, (...args: unknown[]) => unknown>();
    const send = vi.fn();
    const ctx = {
      ipc: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handles.set(channel, fn) },
      send,
      getMainWindow: () => null,
    } as unknown as FeatureContext;
    t.built.feature.register(ctx);
    return { handles, send };
  }

  it('announces each state change of a worker to the renderer, tagged with its controller', async () => {
    const t = setup({ roleAgents: { implementer: 'pi' } });
    const { send } = register(t);
    await t.built.spawnWorker(CALL);

    const states = send.mock.calls
      .filter(([channel]) => channel === 'worker:changed')
      .map(([, payload]) => (payload as { parentKey: string; worker: { state: string; taskId: string; role: string; agentId: string } }));
    expect(states.map((e) => e.worker.state)).toEqual(['queued', 'running', 'done']);
    expect(states.every((e) => e.parentKey === 'proj-a' && e.worker.taskId === 'T-1' && e.worker.role === 'implementer')).toBe(true);
    expect(states[0]?.worker.agentId).toBe('pi');
  });

  it('cancels one worker, or all of a controller, from the renderer', async () => {
    const t = setup({ roleAgents: { implementer: 'pi' } });
    const { handles } = register(t);
    t.gateway.bindSubmit(() => ({ queued: false })); // the worker never ends by itself
    const pending = t.built.spawnWorker(CALL);
    await new Promise((r) => setImmediate(r));

    const [worker] = t.built.registry.list('proj-a');
    expect(handles.get(IPC.workerCancel)?.({}, worker?.id)).toBe(true);
    expect(t.stop).toHaveBeenCalledWith(worker?.runKey);
    expect(handles.get(IPC.workerCancelAll)?.({}, 'proj-a')).toBe(0); // already cancelled
    t.gateway.publish({ type: 'end', project: worker?.runKey as string, code: null, cancelReason: 'user' });
    await pending;
  });

  it('lists the workers of a controller so a reloaded window can redraw them', async () => {
    const t = setup({ roleAgents: { implementer: 'pi' } });
    const { handles } = register(t);
    await t.built.spawnWorker(CALL);
    const listed = handles.get(IPC.workerList)?.({}, 'proj-a') as Array<{ taskId: string; state: string }>;
    expect(listed).toEqual([expect.objectContaining({ taskId: 'T-1', state: 'done' })]);
    expect(handles.get(IPC.workerList)?.({}, 42)).toEqual([]);
  });

  it('ignores a malformed cancel instead of throwing', () => {
    const t = setup();
    const { handles } = register(t);
    expect(handles.get(IPC.workerCancel)?.({}, { not: 'a string' })).toBe(false);
    expect(handles.get(IPC.workerCancelAll)?.({}, null)).toBe(0);
  });
});
