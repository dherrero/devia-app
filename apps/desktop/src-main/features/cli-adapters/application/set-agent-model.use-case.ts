import type { ConfigRepository } from '../../../shared/ports';
import type { AgentModelPrefs } from '../../../../shared/domain/config';
import type { CliAdapterRegistry } from '../domain/ports';

export interface SetAgentModelInput {
  agentId: string;
  model?: string | null;
  reasoning?: string | null;
}

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

function sanitize(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return undefined;
  if (!MODEL_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Persists model + reasoning prefs for one agent. We sanitize so a
 * stale UI cannot smuggle option-like values (`--anything`) that a
 * downstream CLI might misinterpret as a flag.
 */
export class SetAgentModelUseCase {
  constructor(
    private readonly registry: CliAdapterRegistry,
    private readonly config: ConfigRepository,
  ) {}

  execute(input: SetAgentModelInput): AgentModelPrefs {
    const def = this.registry.get(input.agentId);
    if (!def) return {};
    const cfg = this.config.get();
    const current = cfg.agentModels[def.id] ?? {};
    const next: AgentModelPrefs = { ...current };

    const model = sanitize(input.model);
    if (model === undefined) delete next.model; else next.model = model;

    if (def.reasoningOptions && def.reasoningOptions.length > 0) {
      const reasoning = sanitize(input.reasoning);
      if (reasoning === undefined) delete next.reasoning; else next.reasoning = reasoning;
    } else {
      delete next.reasoning;
    }

    const merged = { ...cfg.agentModels, [def.id]: next };
    this.config.set({ agentModels: merged });
    return next;
  }
}
