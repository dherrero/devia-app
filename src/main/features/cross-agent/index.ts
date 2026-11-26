import { randomUUID } from 'node:crypto';
import { normalizeCrossAgentConfig } from '../../../shared/domain/cross-agent-config';
import { isRoleSplit, type RoleAgentMap, type WorkerRole } from '../../../shared/domain/cross-agent';
import type { ConfigRepository, ProjectRegistry } from '../../shared/ports';
import type { EffectiveAgentResolver } from '../../shared/effective-agent-resolver';
import type { RunGateway } from '../../shared/run-gateway';
import { createRunCompletion } from '../../shared/run-completion';
import type { WorktreeRef } from '../git/domain/worktree-ref';
import type { EnsureWorktreeResult } from '../git/infrastructure/cli-git-worktree-manager';
import { integrateWorker } from './application/integrate-worker';
import {
  listAvailableAgents,
  resolveWorkerAgent,
  type WorkerAgentDeps,
} from './application/resolve-worker-agent';
import { SpawnWorkerUseCase, type SpawnWorkerRequest } from './application/spawn-worker.use-case';
import { createWorkerRegistry, type WorkerRegistry } from './application/worker-registry';
import type { GitRunner } from './infrastructure/git-runner';

export interface CrossAgentBuildDeps {
  config: Pick<ConfigRepository, 'get' | 'deviaDir'>;
  registry: Pick<ProjectRegistry, 'find'>;
  effective: Pick<EffectiveAgentResolver, 'forRun'>;
  detector: WorkerAgentDeps['detector'];
  /** The run gateway: workers are started and observed through it. */
  gateway: RunGateway;
  /** Stops the run under a run key. */
  stopRun: (runKey: string) => boolean;
  git: GitRunner;
  /** Creates a worker worktree from an explicit base (never the config's base ref). */
  ensureWorktree: (ref: WorktreeRef, baseRef: string) => EnsureWorktreeResult;
  /** Absolute checkout of a workspace project, or null when it is outside the workspace. */
  projectDir: (project: string, workspaceRoot: string) => string | null;
}

export interface CrossAgentBuilt {
  /** Runs one worker and returns the report the controller reads. */
  spawnWorker: (call: SpawnWorkerRequest) => Promise<string>;
  /** Usable agents as of the last scan: execute() needs a synchronous answer. */
  usableAgentCount: () => number;
  refreshAgents: () => Promise<void>;
  /** Cancels every worker the controller started; returns how many. */
  cancelWorkers: (parentKey: string) => number;
  registry: WorkerRegistry;
  /** Saves the per-project role → agent map (the question tool and the settings use it). */
  roleAgentsOf: (project: string) => RoleAgentMap;
}

/**
 * Composes the cross-agent workers (S-56): the registry, the spawn use case and
 * the lookups `execute()` needs. Limits are read from the config on every
 * decision, so changing them in Settings needs no restart.
 */
export function buildCrossAgentFeature(deps: CrossAgentBuildDeps): CrossAgentBuilt {
  const cfg = () => normalizeCrossAgentConfig(deps.config.get().crossAgent);
  const registry = createWorkerRegistry({
    maxConcurrent: () => cfg().maxConcurrent,
    maxPerTurn: () => cfg().maxPerTurn,
    onChange: () => undefined,
  });

  let usable = 0;
  const refreshAgents = async (): Promise<void> => {
    try {
      usable = (await listAvailableAgents(deps)).length;
    } catch {
      /* keep the last known count: a failed scan must not hide the tool */
    }
  };

  const headOf = (cwd: string): string | null => {
    const result = deps.git.run(cwd, ['rev-parse', 'HEAD']);
    return result.ok && result.stdout.length > 0 ? result.stdout : null;
  };

  const useCase = new SpawnWorkerUseCase({
    config: cfg,
    resolveAgent: (project: string, role: WorkerRole, sessionId?: string) =>
      resolveWorkerAgent(deps, project, role, sessionId),
    registry,
    completion: createRunCompletion(deps.gateway),
    submit: (project, text, opts) => deps.gateway.submit(project, text, opts),
    stop: deps.stopRun,
    deviaDir: () => deps.config.deviaDir(),
    projectDir: (project) => deps.projectDir(project, deps.config.get().workspaceRoot),
    headOf,
    ensureWorktree: deps.ensureWorktree,
    newId: () => randomUUID(),
    integrate: (input) => integrateWorker({ git: deps.git }, input),
    inspect: (cwd) => ({
      head: headOf(cwd),
      dirty: deps.git.run(cwd, ['status', '--porcelain']).stdout.length > 0,
    }),
    roleIsSplit: (project, role) => isRoleSplit(deps.registry.find(project)?.roleAgents, role),
  });

  return {
    spawnWorker: async (call) => (await useCase.execute(call)).rendered,
    usableAgentCount: () => usable,
    refreshAgents,
    cancelWorkers: (parentKey) => registry.cancelParent(parentKey),
    registry,
    roleAgentsOf: (project) => deps.registry.find(project)?.roleAgents ?? {},
  };
}
