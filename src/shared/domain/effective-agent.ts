/**
 * Effective agent resolution (S-53): session > project > global.
 *
 * Pure and dependency-free so both the main process (runs, Telegram, queue,
 * auto-continue, handoff) and the renderer (footer) share one definition.
 */

export type AgentSource = 'session' | 'project' | 'global';

export interface EffectiveAgent {
  agentId: string;
  source: AgentSource;
  /** Set when a higher-priority level named an agent that is not executable. */
  fellBackFrom?: { source: AgentSource; agentId: string };
}

export interface EffectiveAgentInput {
  sessionAgentId?: string | null;
  projectAgentId?: string | null;
  globalAgentId: string;
  isExecutable: (agentId: string) => boolean;
}

function present(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.length > 0;
}

export function resolveEffectiveAgentId(input: EffectiveAgentInput): EffectiveAgent {
  const levels: Array<{ source: AgentSource; id: string | null | undefined }> = [
    { source: 'session', id: input.sessionAgentId },
    { source: 'project', id: input.projectAgentId },
  ];
  let fellBackFrom: EffectiveAgent['fellBackFrom'];
  for (const level of levels) {
    if (!present(level.id)) continue;
    if (input.isExecutable(level.id)) {
      return { agentId: level.id, source: level.source, ...(fellBackFrom && { fellBackFrom }) };
    }
    fellBackFrom ??= { source: level.source, agentId: level.id };
  }
  return { agentId: input.globalAgentId, source: 'global', ...(fellBackFrom && { fellBackFrom }) };
}
