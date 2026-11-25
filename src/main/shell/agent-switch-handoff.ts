/**
 * After an agent change, precompute the handoff summary for every session
 * another agent owns (S-2 F2.3), scoped to what actually changed (S-53):
 * a project-scoped change touches only that project; a global change touches
 * only the projects that follow the global default. Best-effort.
 */
export interface AgentSwitchHandoffDeps {
  /** Set for a project-scoped change; undefined = the global default changed. */
  projectPath: string | undefined;
  entries: () => IterableIterator<
    readonly [string, { agentSessionAgentId: string | null; activeSessionId: string | null; preferredAgentId: string | null }]
  >;
  effectiveAgentId: (projectPath: string) => string;
  /** Pane records are keyed by a session UUID whose base project is unknown here. */
  isPaneKey: (key: string) => boolean;
  loadMessages: (projectPath: string, sessionId: string) => unknown[] | null;
  prepare: (identity: string, sessionId: string, messages: unknown[]) => void;
}

export function prepareHandoffsAfterAgentChange(deps: AgentSwitchHandoffDeps): void {
  for (const [key, record] of deps.entries()) {
    if (deps.projectPath !== undefined) {
      if (key !== deps.projectPath) continue;
    } else if (record.preferredAgentId) {
      continue;
    }
    if (!record.agentSessionAgentId || !record.activeSessionId) continue;
    if (deps.isPaneKey(key)) continue;
    if (record.agentSessionAgentId === deps.effectiveAgentId(key)) continue;
    try {
      const messages = deps.loadMessages(key, record.activeSessionId);
      if (messages && messages.length > 0) deps.prepare(key, record.activeSessionId, messages);
    } catch {
      /* best-effort */
    }
  }
}
