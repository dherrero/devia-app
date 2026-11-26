import {
  parseWorkerReport,
  renderWorkerReport,
  type WorkerReport,
  type WorkerRole,
} from '../../../../shared/domain/cross-agent';
import type { CrossAgentConfig } from '../../../../shared/domain/cross-agent-config';
import type { RunMode } from '../../../../shared/domain/run-capabilities';
import type { SendInstructionResult } from '../../../../shared/domain/queue';
import type { RunCompletion, RunOutcome } from '../../../shared/ports/run-completion.port';
import type { RunSubmitOptions } from '../../../shared/run-gateway';
import { worktreeRefFor, type WorktreeRef } from '../../git/domain/worktree-ref';
import type { EnsureWorktreeResult } from '../../git/infrastructure/cli-git-worktree-manager';
import type { IntegrateWorkerInput, IntegrationResult } from './integrate-worker';
import { buildWorkerPrompt } from './worker-prompt';
import type { WorkerAgentResolution } from './resolve-worker-agent';
import { WorkerLimitError, type WorkerRegistry, type WorkerRun } from './worker-registry';

export interface SpawnWorkerDeps {
  config: () => CrossAgentConfig;
  /** Bound `resolveWorkerAgent`: mapping → effective agent, never a substitute. */
  resolveAgent: (project: string, role: WorkerRole, sessionId?: string) => Promise<WorkerAgentResolution>;
  registry: WorkerRegistry;
  completion: RunCompletion;
  /** The run gateway's submit: it starts the run through the normal runner path. */
  submit: (project: string, text: string, opts: RunSubmitOptions) => SendInstructionResult;
  /** Stops the run under this run key. */
  stop: (runKey: string) => boolean;
  deviaDir: () => string;
  /** Absolute checkout of a workspace project, or null when it is outside the workspace. */
  projectDir: (project: string) => string | null;
  /** `git rev-parse HEAD` in a directory, or null. */
  headOf: (cwd: string) => string | null;
  ensureWorktree: (ref: WorktreeRef, baseRef: string) => EnsureWorktreeResult;
  newId: () => string;
  /** `merge --ff-only` of a worker branch into the controller's, cleaning up on success. */
  integrate: (input: IntegrateWorkerInput) => Promise<IntegrationResult>;
  /** HEAD and dirtiness of a worktree, to catch a reviewer that edited it. */
  inspect: (cwd: string) => { head: string | null; dirty: boolean };
  /** True when the project maps this role to another agent (not "the main agent"). */
  roleIsSplit: (project: string, role: WorkerRole) => boolean;
}

export interface SpawnWorkerRequest {
  /** The BASE project (memory and kanban identity), never the worker's worktree. */
  project: string;
  /** Run key of the controller that asks. */
  parentKey: string;
  /** The controller's current turn (its run id): the per-turn cap counts per turn. */
  turnId: string;
  role: WorkerRole;
  taskId: string;
  /** The controller's mode; the worker inherits it and can never raise it. */
  mode: RunMode;
  /** Where the controller works: its HEAD is the worker's starting point. */
  controllerCwd: string;
}

export interface SpawnWorkerResult {
  report: WorkerReport;
  /** The text the controller receives. */
  rendered: string;
  run?: WorkerRun;
}

/** What an implementer left behind for its task: the reviewer and the fix rounds reuse it. */
interface WorkerWork {
  runKey: string;
  sessionId: string;
  ref: WorktreeRef;
  /** The controller HEAD the worker started from: `baseSha..HEAD` is its work. */
  baseSha: string;
  rounds: number;
}

/**
 * Launches ONE cross-agent worker and waits for its report (S-56).
 *
 * The worker is a real run of the chosen agent under a synthetic run key, in
 * its own worktree cut from the controller's HEAD. Every failure is a report
 * (`BLOCKED` + the reason), never an exception: the controller must be able to
 * read it and decide.
 *
 * An implementer's worktree is kept per (project, task) until its commits are
 * integrated: the reviewer reads it, and a fix round continues in it under the
 * same run key, so the agent resumes its own native session. The record lives in
 * memory: after an app restart a reviewer is told to dispatch the implementer again.
 */
export class SpawnWorkerUseCase {
  private readonly work = new Map<string, WorkerWork>();

  constructor(private readonly deps: SpawnWorkerDeps) {}

  async execute(req: SpawnWorkerRequest): Promise<SpawnWorkerResult> {
    const { deps } = this;
    const blocked = (message: string, agentId = 'n/a', run?: WorkerRun): SpawnWorkerResult => {
      const report: WorkerReport = { status: 'BLOCKED', summary: message, commits: [], raw: message };
      return {
        report,
        rendered: renderWorkerReport({ ...report, agentId, role: req.role, taskId: req.taskId }),
        ...(run && { run }),
      };
    };

    const cfg = deps.config();
    if (!cfg.enabled) return blocked('Cross-agent workers are turned off in Settings.');
    if (deps.registry.rejectIfWorker(req.parentKey)) {
      return blocked('A worker cannot launch workers: delegation goes one level deep only.');
    }
    if (req.mode === 'plan') {
      return blocked('Plan mode cannot launch workers: a worker never has more permission than its controller.');
    }

    const resolved = await deps.resolveAgent(req.project, req.role);
    if (!resolved.ok) return blocked(resolved.message, resolved.agentId);
    const agentId = resolved.agentId;

    const workKey = `${req.project}|${req.taskId}`;
    const existing = this.work.get(workKey);
    if (req.role === 'reviewer' && !existing) {
      return blocked(
        `There is no implementer worker on record for task ${req.taskId}. Dispatch the implementer first (the record is lost when Devia restarts).`,
        agentId,
      );
    }

    let slot;
    try {
      slot = await deps.registry.acquire(req.parentKey, {
        taskId: req.taskId,
        role: req.role,
        agentId,
        turnId: req.turnId,
        // A fix round keeps the implementer's run key (and so its native session).
        ...(req.role === 'implementer' && existing && { runKey: existing.runKey }),
      });
    } catch (err) {
      if (err instanceof WorkerLimitError) return blocked(err.message, agentId);
      throw err;
    }
    const { run } = slot;

    // The controller can be cancelled in the gap between the slot being granted and this line:
    // nobody had registered a cancel yet, so the worker would start anyway.
    if (run.state === 'cancelled') {
      slot.release('cancelled');
      return blocked('The worker was cancelled before it started.', agentId, run);
    }

    // From here on the slot MUST be released, whatever happens.
    try {
      let work = existing;
      if (!work) {
        const checkout = deps.projectDir(req.project);
        if (checkout === null) {
          slot.release('failed');
          return blocked(`The project "${req.project}" is outside the workspace; no worktree can be made for the worker.`, agentId, run);
        }
        const base = deps.headOf(req.controllerCwd);
        if (base === null) {
          slot.release('failed');
          return blocked('Could not read the controller HEAD, so there is no commit to start the worker from.', agentId, run);
        }
        const sessionId = deps.newId();
        const ref = worktreeRefFor(deps.deviaDir(), checkout, sessionId);
        const ensured = deps.ensureWorktree(ref, base);
        if (!ensured.ok) {
          // Never fall back to the base checkout: a worker must not touch it.
          slot.release('failed');
          return blocked(`Could not create the worker's worktree (${ensured.code}); the worker was not started.`, agentId, run);
        }
        work = { runKey: run.runKey, sessionId, ref, baseSha: base, rounds: 0 };
        this.work.set(workKey, work);
      }
      if (req.role === 'implementer') work.rounds += 1;

      const before = req.role === 'reviewer' ? deps.inspect(work.ref.worktreeDir) : undefined;

      deps.registry.registerCancel(run.id, () => deps.stop(run.runKey));
      // Subscribe BEFORE submitting: a run can end synchronously (busy, early exit).
      const done = deps.completion.await(run.runKey, {
        timeoutMs: cfg.defaultTimeoutSec * 1000,
        onTimeout: () => {
          deps.stop(run.runKey);
        },
      });
      const prompt = buildWorkerPrompt({
        role: req.role,
        taskId: req.taskId,
        ...(req.role === 'reviewer' && { baseSha: work.baseSha }),
        ...(req.role === 'implementer' && { round: work.rounds }),
      });
      const submitted = deps.submit(req.project, prompt, {
        mode: req.mode,
        origin: 'renderer',
        runKey: run.runKey,
        sessionId: work.sessionId,
        isolate: true,
        agentIdOverride: agentId,
      });
      if (submitted.queued) {
        deps.stop(run.runKey);
        slot.release('failed');
        return blocked('The worker run was queued instead of started; it was abandoned.', agentId, run);
      }

      const outcome = await done;
      const report = this.buildReport(req, agentId, outcome, cfg);
      if (outcome.status === 'done') {
        await this.finish(req, workKey, work, report, before);
      }
      slot.release(outcome.status === 'done' ? 'done' : outcome.status, outcome.status === 'done' ? report.status : undefined);
      return {
        report,
        rendered: renderWorkerReport({ ...report, agentId, role: req.role, taskId: req.taskId }),
        run,
      };
    } catch (err) {
      slot.release('failed');
      const message = err instanceof Error ? err.message : String(err);
      return blocked(`The worker could not be started: ${message}`, agentId, run);
    }
  }

  /** Reviewer guard, then integration. Mutates `report` so the controller reads the outcome. */
  private async finish(
    req: SpawnWorkerRequest,
    workKey: string,
    work: WorkerWork,
    report: WorkerReport,
    before: { head: string | null; dirty: boolean } | undefined,
  ): Promise<void> {
    const { deps } = this;
    const downgrade = (note: string): void => {
      if (report.status === 'DONE') report.status = 'DONE_WITH_CONCERNS';
      report.summary = `${report.summary}\n\n${note}`;
    };

    if (req.role === 'reviewer' && before) {
      const after = deps.inspect(work.ref.worktreeDir);
      if (after.head !== before.head || (after.dirty && !before.dirty)) {
        downgrade(
          'WARNING: the reviewer modified the worktree (a new commit or uncommitted changes). A reviewer must only read: treat its verdict with care. The work was NOT integrated.',
        );
        return;
      }
    }

    const integrates =
      req.role === 'implementer'
        ? (report.status === 'DONE' || report.status === 'DONE_WITH_CONCERNS') && !deps.roleIsSplit(req.project, 'reviewer')
        : report.status === 'DONE';
    if (!integrates) return;

    const result = await deps.integrate({
      controllerCwd: req.controllerCwd,
      branch: work.ref.branch,
      worktreeDir: work.ref.worktreeDir,
      baseProject: work.ref.baseProject,
    });
    if (result.ok) {
      this.work.delete(workKey);
      const list = result.commits.length > 0 ? result.commits.join(', ') : 'no new commits';
      report.summary = `${report.summary}\n\nIntegrated into your branch (fast-forward): ${list}.`;
      return;
    }
    downgrade(`NOT integrated (${result.reason}): ${result.detail}`);
  }

  private buildReport(
    req: SpawnWorkerRequest,
    agentId: string,
    outcome: RunOutcome,
    cfg: CrossAgentConfig,
  ): WorkerReport {
    const { registry } = this.deps;
    const failed = (summary: string): WorkerReport => {
      const breaker =
        registry.recordFailure(req.taskId) === 'circuit_broken'
          ? ` Circuit breaker: task ${req.taskId} failed 3 times in a row; stop retrying it and ask the user.`
          : '';
      return { status: 'BLOCKED', summary: summary + breaker, commits: [], raw: outcome.finalText };
    };

    switch (outcome.status) {
      case 'done': {
        const report = parseWorkerReport(outcome.finalText);
        if (report.status === 'DONE' || report.status === 'DONE_WITH_CONCERNS') registry.recordSuccess(req.taskId);
        return report;
      }
      case 'cancelled':
        return { status: 'BLOCKED', summary: 'The worker was cancelled before it finished.', commits: [], raw: outcome.finalText };
      case 'timeout':
        return failed(`The worker timed out after ${cfg.defaultTimeoutSec} seconds and was stopped.`);
      case 'failed':
        return failed(`The ${agentId} worker run failed: ${outcome.error ?? 'unknown error'}.`);
    }
  }
}
