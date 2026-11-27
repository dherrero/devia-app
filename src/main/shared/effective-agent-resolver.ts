import {
  resolveEffectiveAgentId,
  type EffectiveAgent,
} from '../../shared/domain/effective-agent';
import type { ProjectRegistry } from './ports';

/**
 * Single main-process entry point for "which agent runs here" (S-53).
 * Runs, Telegram, the queue, auto-continue, handoff and kit detection all go
 * through it so none of them can disagree with what the footer shows.
 */
export interface EffectiveAgentResolver {
  /** `projectPath` is the BASE project (never a pane runKey). */
  forRun(projectPath: string, sessionId?: string): EffectiveAgent;
}

export interface EffectiveAgentResolverDeps {
  config: { get(): { agentId: string } };
  registry: Pick<ProjectRegistry, 'find'>;
  agents: { get(id: string): { providerType?: string | undefined } | null | undefined };
  /** Phase 2: the persisted session's own agent, if any. */
  sessionAgentId?: (projectPath: string, sessionId: string) => string | null | undefined;
}

export function createEffectiveAgentResolver(deps: EffectiveAgentResolverDeps): EffectiveAgentResolver {
  const isExecutable = (id: string): boolean => {
    const def = deps.agents.get(id);
    return !!def && (def.providerType ?? 'cli') === 'cli';
  };
  return {
    forRun(projectPath, sessionId) {
      const project = deps.registry.find(projectPath);
      // No session given = the primary pane: its own active session counts, so the
      // footer, Telegram, the queue and auto-continue agree with what the run uses.
      const sid = sessionId ?? project?.activeSessionId ?? undefined;
      return resolveEffectiveAgentId({
        sessionAgentId: sid !== undefined ? deps.sessionAgentId?.(projectPath, sid) ?? null : null,
        projectAgentId: project?.preferredAgentId ?? null,
        globalAgentId: deps.config.get().agentId,
        isExecutable,
      });
    },
  };
}
