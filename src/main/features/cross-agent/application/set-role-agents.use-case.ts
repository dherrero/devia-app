import type { ProjectRegistry, StateStore } from '../../../shared/ports';
import { MAIN_AGENT, WORKER_ROLES, type RoleAgentMap } from '../../../../shared/domain/cross-agent';

export type SetRoleAgentsResult =
  | { accepted: true; map: RoleAgentMap }
  | { accepted: false; reason: string };

/**
 * Saves which agent runs each worker role for a project (S-56). Input crosses
 * IPC and MCP: nothing is trusted. `{}` clears the map, so every role goes back
 * to the main agent. Takes effect on the next dispatch, so a running run is fine.
 */
export class SetRoleAgentsUseCase {
  constructor(private readonly deps: {
    agents: { get(id: string): { providerType?: string | undefined } | null | undefined };
    projects: Pick<ProjectRegistry, 'getOrCreate'>;
    state: StateStore;
  }) {}

  execute(projectPath: string, map: RoleAgentMap): SetRoleAgentsResult {
    if (typeof projectPath !== 'string' || projectPath.length === 0) {
      return { accepted: false, reason: 'INVALID_PROJECT' };
    }
    if (map === null || typeof map !== 'object' || Array.isArray(map)) {
      return { accepted: false, reason: 'INVALID_MAP' };
    }
    const clean: RoleAgentMap = {};
    for (const [role, agentId] of Object.entries(map)) {
      if (!(WORKER_ROLES as readonly string[]).includes(role)) {
        return { accepted: false, reason: `Unknown role "${role}".` };
      }
      if (typeof agentId !== 'string' || agentId.length === 0) {
        return { accepted: false, reason: `Invalid agent for role "${role}".` };
      }
      if (agentId === MAIN_AGENT) {
        clean[role as keyof RoleAgentMap] = MAIN_AGENT;
        continue;
      }
      const def = this.deps.agents.get(agentId);
      if (!def) return { accepted: false, reason: `Unknown agent id "${agentId}".` };
      if ((def.providerType ?? 'cli') !== 'cli') {
        return { accepted: false, reason: `"${agentId}" is a ${def.providerType} provider — it cannot run instructions.` };
      }
      clean[role as keyof RoleAgentMap] = agentId;
    }
    this.deps.projects.getOrCreate(projectPath).roleAgents = clean;
    this.deps.state.save();
    return { accepted: true, map: clean };
  }
}
