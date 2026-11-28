import { randomUUID } from 'node:crypto';
import { IPC } from '../../../shared/contracts/ipc-channels';
import type { Feature, FeatureContext } from '../../shared/feature';
import { normalizeCrossAgentConfig } from '../../../shared/domain/cross-agent-config';
import { isRoleSplit, type RoleAgentMap, type WorkerRole, type WorkerRun } from '../../../shared/domain/cross-agent';
import type { ConfigRepository, ProjectRegistry, StateStore } from '../../shared/ports';
import type { EffectiveAgentResolver } from '../../shared/effective-agent-resolver';
import type { RunGateway } from '../../shared/run-gateway';
import { createRunCompletion } from '../../shared/run-completion';
import type { WorktreeRef } from '../git/domain/worktree-ref';
import type { EnsureWorktreeResult } from '../git/infrastructure/cli-git-worktree-manager';
import { AssignAgentsUseCase } from './application/assign-agents.use-case';
import { SetRoleAgentsUseCase } from './application/set-role-agents.use-case';
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
  registry: Pick<ProjectRegistry, 'find' | 'getOrCreate'>;
  /** The agent catalog: a role may only be mapped to a known CLI agent. */
  agents: { get(id: string): { providerType?: string | undefined } | null | undefined };
  state: StateStore;
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
  /** Registers the renderer surface: `worker:changed` events and the cancel/list channels. */
  feature: Feature;
  /** `devia_assign_agents`: what to ask per project, and what to save. */
  assignAgents: AssignAgentsUseCase;
  roleAgentsOf: (project: string) => RoleAgentMap;
}

/**
 * Composes the cross-agent workers (S-56): the registry, the spawn use case and
 * the lookups `execute()` needs. Limits are read from the config on every
 * decision, so changing them in Settings needs no restart.
 */
export function buildCrossAgentFeature(deps: CrossAgentBuildDeps): CrossAgentBuilt {
  const cfg = () => normalizeCrossAgentConfig(deps.config.get().crossAgent);
  // Set once the feature registers: before that nobody is listening.
  let announce: ((run: WorkerRun) => void) | null = null;
  const registry = createWorkerRegistry({
    maxConcurrent: () => cfg().maxConcurrent,
    maxPerTurn: () => cfg().maxPerTurn,
    onChange: (run) => {
      // The relay (Telegram) follows workers through the gateway; the renderer through `worker:changed`.
      deps.gateway.publish({ type: 'worker', project: run.parentKey, worker: { ...run } });
      announce?.(run);
    },
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

  const assignAgents = new AssignAgentsUseCase({
    available: () => listAvailableAgents(deps),
    mainAgentId: (project) => deps.effective.forRun(project).agentId,
    current: (project) => deps.registry.find(project)?.roleAgents ?? {},
    save: (project, map) =>
      new SetRoleAgentsUseCase({ agents: deps.agents, projects: deps.registry, state: deps.state }).execute(project, map),
  });

  const feature: Feature = {
    id: 'cross-agent',
    register(ctx: FeatureContext): void {
      // A state change is rare (queued, running, done), so no throttle is needed.
      announce = (run) => ctx.send('worker:changed', { parentKey: run.parentKey, worker: run });
      ctx.ipc.handle(IPC.workerCancel, (_e, workerId: unknown) =>
        typeof workerId === 'string' ? registry.cancel(workerId) : false);
      ctx.ipc.handle(IPC.workerCancelAll, (_e, parentKey: unknown) =>
        typeof parentKey === 'string' ? registry.cancelParent(parentKey) : 0);
      ctx.ipc.handle(IPC.workerList, (_e, parentKey: unknown) =>
        typeof parentKey === 'string' ? registry.list(parentKey) : []);
    },
    onBeforeQuit(): void {
      announce = null;
    },
  };

  return {
    spawnWorker: async (call) => (await useCase.execute(call)).rendered,
    usableAgentCount: () => usable,
    refreshAgents,
    cancelWorkers: (parentKey) => registry.cancelParent(parentKey),
    registry,
    feature,
    assignAgents,
    roleAgentsOf: (project) => deps.registry.find(project)?.roleAgents ?? {},
  };
}
