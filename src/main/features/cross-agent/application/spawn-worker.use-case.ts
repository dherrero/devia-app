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

/**
 * Launches ONE cross-agent worker and waits for its report (S-56).
 *
 * The worker is a real run of the chosen agent under a synthetic run key, in
 * its own worktree cut from the controller's HEAD. Every failure is a report
 * (`BLOCKED` + the reason), never an exception: the controller must be able to
 * read it and decide.
 */
export class SpawnWorkerUseCase {
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

    let slot;
    try {
      slot = await deps.registry.acquire(req.parentKey, {
        taskId: req.taskId,
        role: req.role,
        agentId,
        turnId: req.turnId,
      });
    } catch (err) {
      if (err instanceof WorkerLimitError) return blocked(err.message, agentId);
      throw err;
    }
    const { run } = slot;

    // From here on the slot MUST be released, whatever happens.
    try {
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

      deps.registry.registerCancel(run.id, () => deps.stop(run.runKey));
      // Subscribe BEFORE submitting: a run can end synchronously (busy, early exit).
      const done = deps.completion.await(run.runKey, {
        timeoutMs: cfg.defaultTimeoutSec * 1000,
        onTimeout: () => {
          deps.stop(run.runKey);
        },
      });
      const submitted = deps.submit(req.project, buildWorkerPrompt({ role: req.role, taskId: req.taskId }), {
        mode: req.mode,
        origin: 'renderer',
        runKey: run.runKey,
        sessionId,
        isolate: true,
        agentIdOverride: agentId,
      });
      if (submitted.queued) {
        deps.stop(run.runKey);
        slot.release('failed');
        return blocked('The worker run was queued instead of started; it was abandoned.', agentId, run);
      }

      const outcome = await done;
      const result = this.report(req, agentId, outcome, cfg);
      slot.release(
        outcome.status === 'done' ? 'done' : outcome.status,
        outcome.status === 'done' ? result.report.status : undefined,
      );
      return { ...result, run };
    } catch (err) {
      slot.release('failed');
      const message = err instanceof Error ? err.message : String(err);
      return blocked(`The worker could not be started: ${message}`, agentId, run);
    }
  }

  private report(
    req: SpawnWorkerRequest,
    agentId: string,
    outcome: RunOutcome,
    cfg: CrossAgentConfig,
  ): SpawnWorkerResult {
    const { registry } = this.deps;
    const wrap = (report: WorkerReport): SpawnWorkerResult => ({
      report,
      rendered: renderWorkerReport({ ...report, agentId, role: req.role, taskId: req.taskId }),
    });
    const failed = (summary: string): SpawnWorkerResult => {
      const breaker =
        registry.recordFailure(req.taskId) === 'circuit_broken'
          ? ` Circuit breaker: task ${req.taskId} failed 3 times in a row; stop retrying it and ask the user.`
          : '';
      return wrap({ status: 'BLOCKED', summary: summary + breaker, commits: [], raw: outcome.finalText });
    };

    switch (outcome.status) {
      case 'done': {
        const report = parseWorkerReport(outcome.finalText);
        if (report.status === 'DONE' || report.status === 'DONE_WITH_CONCERNS') registry.recordSuccess(req.taskId);
        return wrap(report);
      }
      case 'cancelled':
        return wrap({ status: 'BLOCKED', summary: 'The worker was cancelled before it finished.', commits: [], raw: outcome.finalText });
      case 'timeout':
        return failed(`The worker timed out after ${cfg.defaultTimeoutSec} seconds and was stopped.`);
      case 'failed':
        return failed(`The ${agentId} worker run failed: ${outcome.error ?? 'unknown error'}.`);
    }
  }
}
