import { describe, it, expect, vi } from 'vitest';
import { SpawnWorkerUseCase, type SpawnWorkerDeps } from './spawn-worker.use-case';
import { createWorkerRegistry } from './worker-registry';
import { DEFAULT_CROSS_AGENT_CONFIG } from '../../../../shared/domain/cross-agent-config';
import type { RunOutcome } from '../../../shared/ports/run-completion.port';
import type { RunSubmitOptions } from '../../../shared/run-gateway';

function setup(over: Partial<SpawnWorkerDeps> & { outcome?: RunOutcome; outcomes?: RunOutcome[] } = {}) {
  const registry = createWorkerRegistry({ maxConcurrent: 3, maxPerTurn: 8, onChange: () => undefined });
  const submitted: Array<{ project: string; text: string; opts: RunSubmitOptions }> = [];
  const stop = vi.fn(() => true);
  const ensureWorktree = vi.fn(() => ({ ok: true as const, created: true }));
  let timeoutCb: (() => void) | undefined;
  const queue = [...(over.outcomes ?? [])];
  const integrate = vi.fn(async () => ({ ok: true as const, commits: ['abc1234'] }));
  const deps: SpawnWorkerDeps = {
    config: () => ({ ...DEFAULT_CROSS_AGENT_CONFIG, enabled: true }),
    resolveAgent: async () => ({ ok: true, agentId: 'pi' }),
    registry,
    completion: {
      await: async (_key, opts) => {
        timeoutCb = opts?.onTimeout;
        return queue.shift() ?? over.outcome ?? { status: 'done', finalText: 'STATUS: DONE\nImplemented.\ncommit abc1234' };
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
    integrate,
    inspect: () => ({ head: 'h1', dirty: false }),
    roleIsSplit: () => false,
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'outcome' && k !== 'outcomes')),
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
  return { uc, req, registry, submitted, stop, ensureWorktree, integrate, fireTimeout: () => timeoutCb?.() };
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

const REVIEWER_OK = { status: 'done', finalText: 'STATUS: DONE\nClean review.' } as const;
const REVIEWER_FINDINGS = { status: 'done', finalText: 'STATUS: DONE_WITH_CONCERNS\n1 Important finding.' } as const;
const IMPLEMENTER_OK = { status: 'done', finalText: 'STATUS: DONE\nImplemented.\ncommit abc1234' } as const;

describe('SpawnWorkerUseCase — integration, reviewer and fix rounds (S-56 T7)', () => {
  it('integrates an implementer DONE into the controller branch when the reviewer role is not split', async () => {
    const t = setup();
    const r = await t.uc.execute(t.req);
    expect(t.integrate).toHaveBeenCalledTimes(1);
    const input = (t.integrate.mock.calls[0] as unknown as [Record<string, string>])[0];
    expect(input).toMatchObject({ controllerCwd: '/ws/proj-a', baseProject: '/ws/proj-a' });
    expect(input['branch']).toMatch(/^devia\/session-/);
    expect(r.rendered).toMatch(/integrated/i);
    expect(r.rendered).toContain('abc1234');
  });

  it('keeps the work on its branch for the reviewer when the reviewer role is split', async () => {
    const t = setup({ roleIsSplit: (_p, role) => role === 'reviewer' });
    await t.uc.execute(t.req);
    expect(t.integrate).not.toHaveBeenCalled();
  });

  it('blocks a reviewer when there is no implementer worker on record for the task', async () => {
    const t = setup();
    const r = await t.uc.execute({ ...t.req, role: 'reviewer' });
    expect(r.report.status).toBe('BLOCKED');
    expect(r.rendered).toMatch(/implementer/i);
    expect(t.submitted).toHaveLength(0);
  });

  it('runs the reviewer in the implementer worktree (same session) under its own run key, with the commit range', async () => {
    const t = setup({ roleIsSplit: () => true, outcomes: [IMPLEMENTER_OK, REVIEWER_OK] });
    await t.uc.execute(t.req);
    await t.uc.execute({ ...t.req, turnId: 'turn-2', role: 'reviewer' });

    expect(t.submitted).toHaveLength(2);
    const [impl, rev] = t.submitted;
    expect(rev?.opts.sessionId).toBe(impl?.opts.sessionId);
    expect(rev?.opts.runKey).not.toBe(impl?.opts.runKey);
    expect(rev?.text).toContain('deadbeef..HEAD');
    expect(t.ensureWorktree).toHaveBeenCalledTimes(1); // the reviewer reuses the existing worktree
  });

  it('integrates after a clean reviewer DONE, but not after findings', async () => {
    const clean = setup({ roleIsSplit: () => true, outcomes: [IMPLEMENTER_OK, REVIEWER_OK] });
    await clean.uc.execute(clean.req);
    await clean.uc.execute({ ...clean.req, turnId: 'turn-2', role: 'reviewer' });
    expect(clean.integrate).toHaveBeenCalledTimes(1);

    const findings = setup({ roleIsSplit: () => true, outcomes: [IMPLEMENTER_OK, REVIEWER_FINDINGS] });
    await findings.uc.execute(findings.req);
    await findings.uc.execute({ ...findings.req, turnId: 'turn-2', role: 'reviewer' });
    expect(findings.integrate).not.toHaveBeenCalled();
  });

  it('a fix round reuses the run key and session of the first implementer run', async () => {
    const t = setup({ roleIsSplit: () => true, outcomes: [IMPLEMENTER_OK, REVIEWER_FINDINGS, IMPLEMENTER_OK] });
    await t.uc.execute(t.req);
    await t.uc.execute({ ...t.req, turnId: 'turn-2', role: 'reviewer' });
    await t.uc.execute({ ...t.req, turnId: 'turn-3' });

    const [first, , fix] = t.submitted;
    expect(fix?.opts.runKey).toBe(first?.opts.runKey);
    expect(fix?.opts.sessionId).toBe(first?.opts.sessionId);
    expect(fix?.text).toMatch(/follow-up round/i);
    expect(first?.text).not.toMatch(/follow-up round/i);
  });

  it('downgrades a DONE that could not be integrated and keeps the work for a retry', async () => {
    const t = setup({ roleIsSplit: () => true, outcomes: [IMPLEMENTER_OK, REVIEWER_OK, REVIEWER_OK] });
    t.integrate.mockResolvedValueOnce({ ok: false, reason: 'not_ff', detail: 'The controller branch moved on.' } as never);
    await t.uc.execute(t.req);
    const r = await t.uc.execute({ ...t.req, turnId: 'turn-2', role: 'reviewer' });
    expect(r.report.status).toBe('DONE_WITH_CONCERNS');
    expect(r.rendered).toContain('The controller branch moved on.');
    // still on record: a second review can try to integrate again
    const again = await t.uc.execute({ ...t.req, turnId: 'turn-3', role: 'reviewer' });
    expect(again.report.status).toBe('DONE');
    expect(t.integrate).toHaveBeenCalledTimes(2);
  });

  it('forgets the work once integrated: the next implementer of that task starts a fresh worktree', async () => {
    let n = 0;
    const t = setup({ newId: () => `session-${++n}` });
    await t.uc.execute(t.req);
    await t.uc.execute({ ...t.req, turnId: 'turn-2' });
    expect(t.submitted[0]?.opts.sessionId).toBe('session-1');
    expect(t.submitted[1]?.opts.sessionId).toBe('session-2');
    expect(t.ensureWorktree).toHaveBeenCalledTimes(2);
  });

  it('warns the controller when a reviewer changed the worktree', async () => {
    let calls = 0;
    const t = setup({
      roleIsSplit: () => true,
      outcomes: [IMPLEMENTER_OK, REVIEWER_OK],
      // before the reviewer: clean at h1; after: a new commit h2 appeared
      inspect: () => ({ head: calls++ < 1 ? 'h1' : 'h2', dirty: false }),
    });
    await t.uc.execute(t.req);
    const r = await t.uc.execute({ ...t.req, turnId: 'turn-2', role: 'reviewer' });
    expect(r.rendered).toMatch(/modified the worktree/i);
    expect(r.report.status).toBe('DONE_WITH_CONCERNS');
    expect(t.integrate).not.toHaveBeenCalled();
  });
});
