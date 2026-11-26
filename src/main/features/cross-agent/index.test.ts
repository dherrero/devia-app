import { describe, it, expect, vi } from 'vitest';
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
  const record = { roleAgents: over.roleAgents ?? {} };
  const deps: CrossAgentBuildDeps = {
    config: {
      get: () => ({ crossAgent: { ...DEFAULT_CROSS_AGENT_CONFIG, enabled: over.enabled ?? true }, workspaceRoot: '/ws', agentId: 'claude' }),
      deviaDir: () => '/dv',
    } as never,
    registry: { find: () => record as never },
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
  return { built, submitted, stop, gitCalls, gateway };
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
