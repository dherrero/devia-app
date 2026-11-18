import type { DeviaConfig } from '../../shared/domain/config';

export type ConfigChangeListener = (config: DeviaConfig) => void;

/**
 * Tells features that live apart from the workspace (which owns `config:set`)
 * when the saved config changed, without importing each other. Created once in
 * the composition root and injected into the publisher and its subscribers.
 */
export class ConfigChangeBus {
  private readonly listeners = new Set<ConfigChangeListener>();

  subscribe(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(config: DeviaConfig): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(config);
      } catch (err: unknown) {
        console.warn('[devia:config-bus] listener failed:', err instanceof Error ? err.message : String(err));
      }
    }
  }
}
