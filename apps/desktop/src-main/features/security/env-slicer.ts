/**
 * Builds the environment passed to a spawned child from an explicit
 * allowlist plus per-provider key-value overrides.
 *
 * Default-deny: only keys on `baseAllowlist` (or in the provider's
 * overrides) are included. The host's full `process.env` is never
 * propagated unless explicitly listed.
 */

export interface EnvSliceConfig {
  /** Keys from the host env to pass through to the child process. */
  baseAllowlist: ReadonlyArray<string>;
  /**
   * Per-provider key-value pairs that override or extend the allowlist.
   * Keyed by provider id. Values are the full set of env vars to merge in.
   */
  perProviderOverrides: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface EnvSlicer {
  /**
   * Build the env object for a given provider, reading only allowed keys
   * from `hostEnv` and merging the provider's overrides on top.
   * Values from `perProviderOverrides` always win over `hostEnv`.
   *
   * @param providerId - The provider whose overrides to include.
   * @param hostEnv - Source of truth for allowed keys (defaults to process.env).
   */
  build(providerId: string, hostEnv?: Readonly<NodeJS.ProcessEnv>): Record<string, string>;
}

export class ConcreteEnvSlicer implements EnvSlicer {
  constructor(private readonly config: EnvSliceConfig) {}

  build(
    providerId: string,
    hostEnv: Readonly<NodeJS.ProcessEnv> = process.env,
  ): Record<string, string> {
    const result: Record<string, string> = {};

    for (const key of this.config.baseAllowlist) {
      const value = hostEnv[key];
      if (typeof value === 'string') {
        result[key] = value;
      }
    }

    const overrides = this.config.perProviderOverrides[providerId];
    if (overrides) {
      for (const [key, value] of Object.entries(overrides)) {
        result[key] = value;
      }
    }

    return result;
  }
}

/**
 * Default base allowlist for agent child processes.
 * Only safe, non-secret env keys that agents typically need.
 */
export const DEFAULT_ENV_ALLOWLIST: ReadonlyArray<string> = [
  'PATH',
  'HOME',
  'USER',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'NODE_ENV',
  'npm_config_cache',
  // Agent-specific (never secrets — just identity/config paths)
  'CLAUDE_CONFIG_DIR',
];
