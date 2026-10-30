import type { AgentDetector, CliAdapterRegistry } from '../../domain/ports';
import type { DetectedAgent } from '../../domain/runtime-agent-def';
import { detectAgent, detectAgentSafe } from './detect-agent';

export interface AgentDetectorDeps {
  registry: CliAdapterRegistry;
  /**
   * Per-agent env overrides accessor. Returns the allowlist values for
   * the given agent id; the detection passes them to the underlying
   * probe so e.g. a custom `ANTHROPIC_API_KEY` is honored when listing
   * models.
   */
  getEnvOverrides(agentId: string): Record<string, string>;
}

/** TTL for the detection results cache (60 seconds). */
const DETECTION_CACHE_TTL_MS = 60_000;

export class ParallelAgentDetector implements AgentDetector {
  private _cache: { result: DetectedAgent[]; expiresAt: number } | null = null;

  constructor(private readonly deps: AgentDetectorDeps) {}

  detectAll(): Promise<DetectedAgent[]> {
    if (this._cache && Date.now() < this._cache.expiresAt) {
      return Promise.resolve(this._cache.result);
    }
    // `detectAgentSafe` wraps each per-agent detection in a catch so a
    // thrown error never aborts the parallel run — the offending provider
    // surfaces as `available: false` with the error in `unavailableReason`
    // and the rest of the catalog still loads.
    const promise = Promise.all(
      this.deps.registry.all().map((def) =>
        detectAgentSafe(def, { envOverrides: this.deps.getEnvOverrides(def.id) }),
      ),
    );
    promise.then((result) => {
      this._cache = { result, expiresAt: Date.now() + DETECTION_CACHE_TTL_MS };
    }).catch(() => { /* detection errors are handled per-agent; swallow here */ });
    return promise;
  }

  async detectOne(id: string): Promise<DetectedAgent | null> {
    const def = this.deps.registry.get(id);
    if (!def) return null;
    return detectAgent(def, { envOverrides: this.deps.getEnvOverrides(def.id) });
  }

  /**
   * Invalidate the detection cache. Call after the user selects a new agent
   * so the next `detectAll()` re-probes and reflects the updated selection.
   */
  invalidateCache(): void {
    this._cache = null;
  }
}
