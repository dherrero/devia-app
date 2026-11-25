import type { ProjectRegistry, SessionStore, StateStore } from '../../../shared/ports';
import type { EffectiveAgentResolver } from '../../../shared/effective-agent-resolver';
import type {
  SetContextAgentInput,
  SetContextAgentResult,
} from '../../../../shared/domain/effective-agent';

/**
 * Sets (or clears) the agent a PROJECT runs with (S-53). The global default is
 * still `SelectAgentUseCase`. Scope 'session' lands with the session agent.
 */
export class SetContextAgentUseCase {
  constructor(private readonly deps: {
    agents: { get(id: string): { providerType?: string | undefined } | null | undefined };
    projects: Pick<ProjectRegistry, 'getOrCreate' | 'isRunning' | 'find'>;
    sessions?: Pick<SessionStore, 'isValidSessionId'>;
    /** Per-session agent (phase 2); absent → the session scope is refused. */
    sessionAgents?: { set(projectPath: string, sessionId: string, agentId: string | null): void };
    state: StateStore;
    effective: EffectiveAgentResolver;
    /** Fired after a successful change so foreign-session handoffs are precomputed. */
    onSelected?: (agentId: string, projectPath: string) => void;
  }) {}

  execute(input: SetContextAgentInput): SetContextAgentResult {
    const current = (): SetContextAgentResult['effective'] =>
      this.deps.effective.forRun(input.projectPath, input.sessionId);
    const reject = (rejectedReason: string): SetContextAgentResult =>
      ({ accepted: false, effective: current(), rejectedReason });

    if (input.scope === 'session' && !(this.deps.sessionAgents && this.deps.sessions)) {
      return reject('SCOPE_UNSUPPORTED');
    }
    if (input.scope === 'session' && !this.deps.sessions?.isValidSessionId(input.sessionId)) {
      return reject('INVALID_SESSION');
    }

    if (input.agentId !== null) {
      const def = this.deps.agents.get(input.agentId);
      if (!def) return reject(`Unknown agent id "${input.agentId}".`);
      if ((def.providerType ?? 'cli') !== 'cli') {
        return reject(`"${input.agentId}" is a ${def.providerType} provider — it cannot run instructions.`);
      }
    }

    if (input.scope === 'session') {
      const sessionId = input.sessionId as string;
      // A pane runs under its session id; the primary pane under the project path.
      const primaryRunsIt =
        this.deps.projects.find(input.projectPath)?.activeSessionId === sessionId
        && this.deps.projects.isRunning(input.projectPath);
      if (primaryRunsIt || this.deps.projects.isRunning(sessionId)) return reject('AGENT_RUN_ACTIVE');
      this.deps.sessionAgents!.set(input.projectPath, sessionId, input.agentId);
      return { accepted: true, effective: current() };
    }

    if (this.deps.projects.isRunning(input.projectPath)) return reject('AGENT_RUN_ACTIVE');

    this.deps.projects.getOrCreate(input.projectPath).preferredAgentId = input.agentId;
    this.deps.state.save();
    const effective = current();
    try {
      this.deps.onSelected?.(effective.agentId, input.projectPath);
    } catch {
      /* notification is best-effort */
    }
    return { accepted: true, effective };
  }
}
