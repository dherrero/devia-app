import type { EffectiveAgentResolver } from '../../../shared/effective-agent-resolver';
import type { EffectiveAgent } from '../../../../shared/domain/effective-agent';

/** Which agent a project (and optionally a session) runs with right now (S-53). */
export class GetEffectiveAgentUseCase {
  constructor(private readonly deps: { effective: EffectiveAgentResolver }) {}

  execute(input: { projectPath: string; sessionId?: string }): EffectiveAgent {
    return this.deps.effective.forRun(input.projectPath, input.sessionId);
  }
}
