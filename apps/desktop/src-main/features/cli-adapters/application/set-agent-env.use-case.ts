import type { ConfigRepository } from '../../../shared/ports';
import type { CliAdapterRegistry } from '../domain/ports';

export interface SetAgentEnvInput {
  agentId: string;
  env: Record<string, string>;
}

/**
 * Persists per-agent env overrides. The launcher already enforces the
 * allowlist at spawn time, but we also filter here so the on-disk
 * config doesn't accumulate rejected keys that the user will never
 * remove via the UI.
 */
export class SetAgentEnvUseCase {
  constructor(
    private readonly registry: CliAdapterRegistry,
    private readonly config: ConfigRepository,
  ) {}

  execute(input: SetAgentEnvInput): Record<string, string> {
    const def = this.registry.get(input.agentId);
    if (!def) return {};
    const allowed = new Set(def.envOverrideKeys ?? []);
    const cleaned: Record<string, string> = {};
    for (const [key, raw] of Object.entries(input.env ?? {})) {
      if (!allowed.has(key)) continue;
      if (typeof raw !== 'string') continue;
      const value = raw.trim();
      if (value.length === 0) continue;
      cleaned[key] = value;
    }
    const cfg = this.config.get();
    const merged = { ...cfg.agentCliEnv, [def.id]: cleaned };
    this.config.set({ agentCliEnv: merged });
    return cleaned;
  }
}
