import type { RuntimeAgentDef } from '../../cli-adapters/domain/runtime-agent-def';
import type { AgentMapper } from './agent-mapper';

/**
 * Resolves the mapper for an agent. Agents with a dedicated mapper (Claude, pi,
 * OpenCode — S-30 phase 1) get it; every other def is wrapped by the legacy
 * mapper so it keeps its exact pre-refactor behaviour until its own phase.
 */
export interface MapperRegistry {
  forDef(def: RuntimeAgentDef): AgentMapper;
}
