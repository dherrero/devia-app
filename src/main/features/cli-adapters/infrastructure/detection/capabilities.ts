/**
 * Per-agent capability flags discovered by probing `<bin> <helpArgs>` and
 * grepping the output for known option strings. Used by `buildArgs()` to
 * gate optional flags so an older CLI build doesn't reject the run with
 * "unknown option".
 *
 * Module-level singleton so `defs/claude.ts` can read the latest probe
 * results without threading the map through every call site (matches
 * open-design's pattern at apps/daemon/src/runtimes/capabilities.ts).
 */
export type CapabilityMap = Record<string, boolean>;

class AgentCapabilities {
  private readonly map = new Map<string, CapabilityMap>();

  set(agentId: string, caps: CapabilityMap): void {
    this.map.set(agentId, caps);
  }

  get(agentId: string): CapabilityMap | undefined {
    return this.map.get(agentId);
  }

  clear(): void {
    this.map.clear();
  }
}

export const agentCapabilities = new AgentCapabilities();
