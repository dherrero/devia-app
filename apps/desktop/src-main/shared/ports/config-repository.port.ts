import type { DeviaConfig } from '../../../shared/domain/config';

/**
 * Read/write access to the user-facing app configuration. Owned by the
 * `workspace` feature but consumed by ~half of the other features, hence it
 * lives in shared ports.
 *
 * Read at use-time (never destructured at module load) so a config change at
 * runtime — e.g. user picks a workspace from the onboarding modal — is
 * picked up by every adapter that follows.
 */
export interface ConfigRepository {
  get(): DeviaConfig;
  set(partial: Partial<DeviaConfig>): DeviaConfig;
  reload(): DeviaConfig;
  hasWorkspace(): boolean;
  configPath(): string;
  deviaDir(): string;
}
