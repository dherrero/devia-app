import type { ProjectRegistry, StateStore } from '../../../shared/ports';

export class ResetSessionUseCase {
  constructor(private readonly deps: {
    registry: ProjectRegistry;
    state: StateStore;
  }) {}

  execute(projectName: string): true {
    // A reset starts the conversation from scratch, so a run still streaming
    // belongs to the OLD session. Kill it first (no-op when idle) — otherwise
    // the in-flight agent keeps generating with the previous context and its
    // output lands in the fresh session (E-DSK-14 /clean mid-run).
    this.deps.registry.stopProject(projectName);
    const record = this.deps.registry.getOrCreate(projectName);
    record.newSession = true;
    // Clear the link to the on-disk session so the next instruction creates
    // a fresh session-<id>.json. The previous file stays on disk for future
    // history browsing.
    record.activeSessionId = null;
    // Clear the agent-generated session ID so the next run starts fresh
    // (no --resume) and the agent emits a new session_started event.
    record.agentSessionId = null;
    record.agentSessionAgentId = null;
    this.deps.state.save();
    return true;
  }
}
