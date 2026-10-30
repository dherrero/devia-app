import type { AgentProvider } from '../../../../shared/domain/agent-provider';

/**
 * Registry that enforces unique provider ids and supports both built-in
 * and dynamically loaded providers.
 */
export interface ProviderRegistry {
  /**
   * Register a provider. Throws with a clear message when `provider.id`
   * is already registered (AC2).
   */
  register(provider: AgentProvider): void;

  /**
   * Look up a provider by id. Returns `undefined` when not found.
   */
  get(id: string): AgentProvider | undefined;

  /**
   * List all registered providers in registration order.
   */
  list(): readonly AgentProvider[];
}

/**
 * Concrete in-memory implementation used by the main process.
 */
export class ConcreteProviderRegistry implements ProviderRegistry {
  private readonly providers = new Map<string, AgentProvider>();

  register(provider: AgentProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Duplicate provider id: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): AgentProvider | undefined {
    return this.providers.get(id);
  }

  list(): readonly AgentProvider[] {
    return [...this.providers.values()];
  }
}
