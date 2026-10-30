import type { DetectedAgent, RuntimeAgentDef } from './runtime-agent-def';

/**
 * Read-only catalog of every CLI the app knows how to drive. Implementations
 * are static arrays for built-in defs; additional defs may be registered at
 * runtime via `registerAdditional`.
 */
export interface CliAdapterRegistry {
  all(): readonly RuntimeAgentDef[];
  get(id: string): RuntimeAgentDef | null;
  /**
   * Register agent defs loaded from the user's config directory at startup.
   * Invalid entries are skipped; duplicates of built-in ids are rejected.
   */
  registerAdditional(defs: RuntimeAgentDef[]): void;
  /**
   * Returns install / docs URLs for a given agent id.
   * Returns an empty object when the id is not found.
   */
  installMetaForAgent(id: string): { installUrl?: string; docsUrl?: string };
}

/**
 * Probes every CLI on the host and returns a `DetectedAgent` per entry.
 * Each result is independent so a slow CLI cannot starve the others.
 */
export interface AgentDetector {
  detectAll(): Promise<DetectedAgent[]>;
  detectOne(id: string): Promise<DetectedAgent | null>;
}
