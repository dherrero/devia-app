import type { RoleAgentMap, WorkerRole } from '../../../../shared/domain/cross-agent';
import type { ProjectRegistry } from '../../../shared/ports';
import type { EffectiveAgentResolver } from '../../../shared/effective-agent-resolver';

/** The slice of `DetectedAgent` this feature needs; the real detector satisfies it. */
export interface DetectedAgentLike {
  id: string;
  available: boolean;
  providerType?: string | undefined;
  authStatus?: 'ok' | 'missing' | 'unknown' | undefined;
  authMessage?: string | undefined;
  unavailableReason?: string | undefined;
}

export interface WorkerAgentDeps {
  registry: Pick<ProjectRegistry, 'find'>;
  effective: Pick<EffectiveAgentResolver, 'forRun'>;
  detector: {
    detectOne(id: string): Promise<DetectedAgentLike | null>;
    detectAll(): Promise<DetectedAgentLike[]>;
  };
}

export type WorkerAgentFailure = 'unknown_agent' | 'not_executable' | 'not_installed' | 'not_authenticated';

export type WorkerAgentResolution =
  | { ok: true; agentId: string }
  | { ok: false; agentId: string; reason: WorkerAgentFailure; message: string };

/** An unknown auth state counts as usable: it cannot be proven missing. */
export function isUsableAgent(a: DetectedAgentLike): boolean {
  return a.available && (a.providerType ?? 'cli') === 'cli' && a.authStatus !== 'missing';
}

/**
 * Which agent runs a worker of `role` in `projectPath`: the project's role
 * mapping, else the effective (main) agent. If that agent cannot run now, the
 * result is a failure — NEVER another agent: swapping would change cost and
 * results from what the user approved (S-56).
 */
export async function resolveWorkerAgent(
  deps: WorkerAgentDeps,
  projectPath: string,
  role: WorkerRole,
  sessionId?: string,
): Promise<WorkerAgentResolution> {
  const mapped = (deps.registry.find(projectPath)?.roleAgents as RoleAgentMap | undefined)?.[role];
  const agentId = mapped ?? deps.effective.forRun(projectPath, sessionId).agentId;
  const detected = await deps.detector.detectOne(agentId);
  if (!detected) {
    return { ok: false, agentId, reason: 'unknown_agent', message: `The agent "${agentId}" is not known to Devia.` };
  }
  if ((detected.providerType ?? 'cli') !== 'cli') {
    return { ok: false, agentId, reason: 'not_executable', message: `"${agentId}" cannot run instructions (it is not a CLI agent).` };
  }
  if (!detected.available) {
    const why = detected.unavailableReason ? ` ${detected.unavailableReason}` : '';
    return { ok: false, agentId, reason: 'not_installed', message: `The agent "${agentId}" is not installed or not found.${why}` };
  }
  if (detected.authStatus === 'missing') {
    const why = detected.authMessage ? ` ${detected.authMessage}` : '';
    return { ok: false, agentId, reason: 'not_authenticated', message: `The agent "${agentId}" has no valid credentials.${why}` };
  }
  return { ok: true, agentId };
}

/** Agents that can take a worker right now, in detector order (the picker's options). */
export async function listAvailableAgents(deps: Pick<WorkerAgentDeps, 'detector'>): Promise<string[]> {
  return (await deps.detector.detectAll()).filter(isUsableAgent).map((a) => a.id);
}
