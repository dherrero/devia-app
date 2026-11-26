import { describe, it, expect, vi } from 'vitest';
import { SpawnWorkerUseCase, type SpawnWorkerDeps } from './spawn-worker.use-case';
import { createWorkerRegistry } from './worker-registry';
import { DEFAULT_CROSS_AGENT_CONFIG } from '../../../../shared/domain/cross-agent-config';
import type { RunOutcome } from '../../../shared/ports/run-completion.port';
import type { RunSubmitOptions } from '../../../shared/run-gateway';

function setup(over: Partial<SpawnWorkerDeps> & { outcome?: RunOutcome } = {}) {
  const registry = createWorkerRegistry({ maxConcurrent: 3, maxPerTurn: 8, onChange: () => undefined });
  const submitted: Array<{ project: string; text: string; opts: RunSubmitOptions }> = [];
  const stop = vi.fn(() => true);
  const ensureWorktree = vi.fn(() => ({ ok: true as const, created: true }));
  let timeoutCb: (() => void) | undefined;
  const deps: SpawnWorkerDeps = {
    config: () => ({ ...DEFAULT_CROSS_AGENT_CONFIG, enabled: true }),
    resolveAgent: async () => ({ ok: true, agentId: 'pi' }),
    registry,
    completion: {
      await: async (_key, opts) => {
        timeoutCb = opts?.onTimeout;
        return over.outcome ?? { status: 'done', finalText: 'STATUS: DONE\nImplemented.\ncommit abc1234' };
      },
    },
    submit: (project, text, opts) => {
      submitted.push({ project, text, opts });
      return { queued: false };
    },
    stop,
    deviaDir: () => '/dv',
    projectDir: () => '/ws/proj-a',
    headOf: () => 'deadbeef',
    ensureWorktree,
    newId: () => '11111111-2222-3333-4444-555555555555',
    ...over,
  };
  const uc = new SpawnWorkerUseCase(deps);
  const req = {
    project: 'proj-a',
    parentKey: 'proj-a',
    turnId: 'turn-1',
    role: 'implementer' as const,
    taskId: 'T-1',
    mode: 'apply' as const,
    controllerCwd: '/ws/proj-a',
  };
  return { uc, req, registry, submitted, stop, ensureWorktree, fireTimeout: () => timeoutCb?.() };
}

describe('SpawnWorkerUseCase', () => {
  it('runs the worker in its own worktree under the resolved agent and returns the report', async () => {
    const t = setup();
    const r = await t.uc.execute(t.req);

    expect(r.report.status).toBe('DONE');
    expect(r.report.commits).toEqual(['abc1234']);
    expect(r.rendered).toContain('pi');
    expect(r.rendered).toContain('T-1');

    expect(t.ensureWorktree).toHaveBeenCalledTimes(1);
    const [ref, base] = t.ensureWorktree.mock.calls[0] as unknown as [{ baseProject: string; sessionId: string }, string];
    expect(ref.baseProject).toBe('/ws/proj-a');
    expect(ref.sessionId).toBe('11111111-2222-3333-4444-555555555555');
    expect(base).toBe('deadbeef'); // the controller's HEAD, not the default branch

    expect(t.submitted).toHaveLength(1);
    expect(t.submitted[0]?.project).toBe('proj-a'); // the BASE project: memory/kanban identity
    expect(t.submitted[0]?.opts).toMatchObject({
      mode: 'apply',
      origin: 'renderer',
      isolate: true,
      agentIdOverride: 'pi',
      sessionId: '11111111-2222-3333-4444-555555555555',
    });
    expect(t.submitted[0]?.opts.runKey).toMatch(/^devia-worker:proj-a:T-1:/);
    expect(t.submitted[0]?.text).toContain('T-1');
  });

  it('inherits the mode and never escalates: a plan-mode controller launches nothing', async () => {
    const t = setup();
    const r = await t.uc.execute({ ...t.req, mode: 'plan' });
    expect(r.report.status).toBe('BLOCKED');
    expect(r.rendered).toMatch(/plan mode/i);
    expect(t.submitted).toHaveLength(0);
  });

  it('passes apply-yolo through unchanged', async () => {
    const t = setup();
    await t.uc.execute({ ...t.req, mode: 'apply-yolo' });
    expect(t.submitted[0]?.opts.mode).toBe('apply-yolo');
  });

  it('refuses when the feature is off', async () => {
    const t = setup({ config: () => ({ ...DEFAULT_CROSS_AGENT_CONFIG, enabled: false }) });
    const r = await t.uc.execute(t.req);
    expect(r.report.status).toBe('BLOCKED');
    expect(t.submitted).toHaveLength(0);
  });

  it('refuses delegation from a worker (depth 1)', async () => {
    const t = setup();
    const r = await t.uc.execute({ ...t.req, parentKey: 'devia-worker:proj-a:T-0:1' });
    expect(r.report.status).toBe('BLOCKED');
    expect(r.rendered).toMatch(/worker/i);
    expect(t.submitted).toHaveLength(0);
  });

  it('blocks without launching when the mapped agent is not available (no substitution)', async () => {
    const t = setup({
      resolveAgent: async () => ({ ok: false, agentId: 'pi', reason: 'not_installed', message: 'The agent "pi" is not installed or not found.' }),
    });
    const r = await t.uc.execute(t.req);
    expect(r.report.status).toBe('BLOCKED');
    expect(r.rendered).toContain('not installed');
    expect(t.submitted).toHaveLength(0);
    expect(t.ensureWorktree).not.toHaveBeenCalled();
  });

  it('fails the worker, and never falls back to the base checkout, when the worktree cannot be made', async () => {
    const t = setup({ ensureWorktree: vi.fn(() => ({ ok: false as const, code: 'not-a-repo' as never })) });
    const r = await t.uc.execute(t.req);
    expect(r.report.status).toBe('BLOCKED');
    expect(r.rendered).toMatch(/worktree/i);
    expect(t.submitted).toHaveLength(0);
  });

  it('fails when the controller HEAD cannot be read', async () => {
    const t = setup({ headOf: () => null });
    const r = await t.uc.execute(t.req);
    expect(r.report.status).toBe('BLOCKED');
    expect(t.submitted).toHaveLength(0);
  });

  it('resolves a timeout by stopping the worker and reporting it', async () => {
    const t = setup({ outcome: { status: 'timeout', finalText: 'half done' } });
    const r = await t.uc.execute(t.req);
    expect(r.report.status).toBe('BLOCKED');
    expect(r.rendered).toMatch(/timed out/i);
    t.fireTimeout();
    expect(t.stop).toHaveBeenCalledWith(expect.stringMatching(/^devia-worker:/));
  });

  it('reports a failed run with its error and counts it toward the circuit breaker', async () => {
    const t = setup({ outcome: { status: 'failed', finalText: '', error: 'boom' } });
    expect((await t.uc.execute(t.req)).rendered).toContain('boom');
    expect((await t.uc.execute({ ...t.req, turnId: 'turn-2' })).rendered).toContain('boom');
    const third = await t.uc.execute({ ...t.req, turnId: 'turn-3' });
    expect(third.rendered).toMatch(/circuit/i);
  });

  it('reports a cancelled worker as such', async () => {
    const t = setup({ outcome: { status: 'cancelled', finalText: '' } });
    const r = await t.uc.execute(t.req);
    expect(r.report.status).toBe('BLOCKED');
    expect(r.rendered).toMatch(/cancel/i);
  });

  it('turns a text without the STATUS contract into BLOCKED', async () => {
    const t = setup({ outcome: { status: 'done', finalText: 'I did stuff.' } });
    const r = await t.uc.execute(t.req);
    expect(r.report.status).toBe('BLOCKED');
    expect(r.report.summary).toContain('I did stuff.');
  });

  it('frees the slot on every outcome (a later worker is not queued behind a dead one)', async () => {
    const t = setup({ outcome: { status: 'failed', finalText: '', error: 'x' } });
    await t.uc.execute(t.req);
    expect(t.registry.list('proj-a').every((w) => w.state !== 'running' && w.state !== 'queued')).toBe(true);
  });

  it('registers a cancel that stops exactly this worker run', async () => {
    let cancelFn: (() => void) | undefined;
    const t = setup();
    const original = t.registry.registerCancel.bind(t.registry);
    t.registry.registerCancel = (id, cancel) => {
      cancelFn = cancel;
      original(id, cancel);
    };
    await t.uc.execute(t.req);
    cancelFn?.();
    expect(t.stop).toHaveBeenCalledWith(expect.stringMatching(/^devia-worker:proj-a:T-1:/));
  });
});
