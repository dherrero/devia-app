import type { DetectedAgentView } from '../../../../../../types/devia';

export interface AgentPanelState {
  expandedAgentId: string | null;
  resetEnv: boolean;
  emitSelection: boolean;
}

export function filterVisibleAgents(
  agents: DetectedAgentView[],
  selectedAgentId: string,
  rawQuery: string,
): DetectedAgentView[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return agents;
  return agents.filter((agent) =>
    agent.id === selectedAgentId || matchesAgentQuery(agent, query),
  );
}

export function getNextAgentPanelState(
  selectedAgentId: string,
  expandedAgentId: string | null,
  clickedAgentId: string,
): AgentPanelState {
  if (clickedAgentId !== selectedAgentId) {
    return { expandedAgentId: clickedAgentId, resetEnv: true, emitSelection: true };
  }

  const nextExpandedAgentId = expandedAgentId === clickedAgentId ? null : clickedAgentId;
  return {
    expandedAgentId: nextExpandedAgentId,
    resetEnv: nextExpandedAgentId !== null,
    emitSelection: false,
  };
}

function matchesAgentQuery(agent: DetectedAgentView, query: string): boolean {
  return [
    agent.name,
    agent.id,
    agent.providerType,
    agent.bin,
    agent.resolvedBin,
    agent.path,
    agent.version ?? '',
  ].some((value) => value?.toLowerCase().includes(query));
}
