import type { ConfigRepository } from '../../../shared/ports';
import type { CliAdapterRegistry } from '../domain/ports';

export interface SelectAgentInput {
  agentId: string;
}

export interface SelectAgentResult {
  agentId: string;
  /**
   * `false` when the requested id was rejected because the provider is
   * not selectable (unknown id, planned provider, non-CLI integration
   * type not yet implemented). The renderer surfaces this so the user
   * understands why the active agent did not change.
   */
  accepted: boolean;
  /** Human-readable reason the request was rejected, if any. */
  rejectedReason?: string;
}

/**
 * Persists the user's chosen CLI to disk. Validates against the static
 * registry so a stale or hostile renderer can't smuggle in an unknown
 * id; falls back to the current selection on rejection.
 *
 * REV-AGENT-CORE-014: now refuses to activate providers whose
 * `providerType` is not `'cli'`. Those entries (direct API, MCP, local
 * model, planned ACP agents) live in the registry only so the UI can
 * surface them — Devia has no execution path for them yet, and switching
 * the active agent to one of them would break every subsequent run.
 */
export class SelectAgentUseCase {
  constructor(
    private readonly registry: CliAdapterRegistry,
    private readonly config: ConfigRepository,
    /** S-2 F2.3: fired after a successful switch so handoff summaries for
     *  foreign-owned sessions can be precomputed. Best-effort. */
    private readonly onSelected?: (agentId: string) => void,
  ) {}

  execute(input: SelectAgentInput): SelectAgentResult {
    const current = this.config.get().agentId;
    const def = this.registry.get(input.agentId);

    if (!def) {
      return {
        agentId: current,
        accepted: false,
        rejectedReason: `Unknown agent id "${input.agentId}".`,
      };
    }

    const providerType = def.providerType ?? 'cli';
    if (providerType !== 'cli') {
      return {
        agentId: current,
        accepted: false,
        rejectedReason:
          def.unavailableReason ??
          `"${def.name}" is a ${providerType} provider — execution support is not implemented yet.`,
      };
    }

    this.config.set({ agentId: def.id });
    try {
      this.onSelected?.(def.id);
    } catch {
      /* notification is best-effort */
    }
    return { agentId: def.id, accepted: true };
  }
}
