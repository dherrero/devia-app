import type { ProjectRegistry, StateStore } from '../../../shared/ports';
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
    projects: Pick<ProjectRegistry, 'getOrCreate' | 'isRunning'>;
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

    if (input.scope !== 'project') return reject('SCOPE_UNSUPPORTED');

    if (input.agentId !== null) {
      const def = this.deps.agents.get(input.agentId);
      if (!def) return reject(`Unknown agent id "${input.agentId}".`);
      if ((def.providerType ?? 'cli') !== 'cli') {
        return reject(`"${input.agentId}" is a ${def.providerType} provider — it cannot run instructions.`);
      }
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
