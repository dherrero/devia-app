import * as path from 'node:path';
import type { RuntimeAgentDef } from '../domain/runtime-agent-def';

/**
 * Returns the actual key under which the PATH variable is stored in `env`,
 * performing a case-insensitive lookup.
 *
 * On Windows, `process.env` preserves the original casing of inherited
 * environment variables. The PATH variable is commonly stored as `'Path'`
 * in PowerShell environments rather than `'PATH'`. Using a fixed-case
 * `env['PATH']` lookup on Windows silently returns `undefined` when the
 * variable is stored as `'Path'`, causing all prior PATH entries to be lost.
 *
 * Falls back to `'PATH'` when no PATH-equivalent key is found (safe on all
 * platforms — `spawn` normalises env keys on macOS and Linux).
 *
 * Exported for unit testing.
 */
export function findPathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}

/**
 * Prepend `dirs` to the PATH variable in `env`, preserving the original key
 * casing (e.g. `'Path'` on Windows). Modifies `env` in place and returns it.
 *
 * Exported for unit testing.
 */
export function prependToPath(
  env: NodeJS.ProcessEnv,
  dirs: string[],
): NodeJS.ProcessEnv {
  if (dirs.length === 0) return env;
  const pathKey = findPathKey(env);
  const existingPath = env[pathKey] ?? '';
  env[pathKey] = [...dirs, existingPath].filter(Boolean).join(path.delimiter);
  return env;
}

/**
 * Result of composing the child process environment.
 */
export interface SpawnEnvResult {
  /** The fully composed env object to pass to `spawn`. */
  env: NodeJS.ProcessEnv;
  /** Keys that were removed (for diagnostics/logging). */
  stripped: string[];
}

/**
 * Compose the environment for a spawned agent process.
 *
 * Order of precedence (highest last wins):
 *   1. `process.env` — inherited parent environment
 *   2. `def.env` — built-in static env declared in the agent def
 *   3. `overrides` — user-supplied values, filtered through `def.envOverrideKeys`
 *
 * Post-composition strip for Claude:
 *   If `def.id === 'claude'` and `ANTHROPIC_BASE_URL` is **not** present in
 *   the composed env, every key whose `.toUpperCase()` equals
 *   `'ANTHROPIC_API_KEY'` is removed. This prevents the parent process key
 *   from silently billing the user when Claude Code has its own login session.
 *
 * This function never throws. On unexpected errors it returns `process.env`
 * with an empty `stripped` list, which is always safe.
 */
export function buildSpawnEnv(
  def: RuntimeAgentDef,
  overrides: Record<string, string>,
): SpawnEnvResult {
  try {
    // 1. Start with a copy of the parent environment.
    const env: NodeJS.ProcessEnv = { ...process.env };

    // 2. Apply built-in env from the def.
    if (def.env != null) {
      Object.assign(env, def.env);
    }

    // 3. Apply user overrides filtered through the allowlist.
    if (Object.keys(overrides).length > 0) {
      const allowed = new Set(def.envOverrideKeys ?? []);
      for (const [key, value] of Object.entries(overrides)) {
        if (allowed.has(key) && typeof value === 'string' && value.length > 0) {
          env[key] = value;
        }
      }
    }

    // 4. Claude-specific: strip ANTHROPIC_API_KEY unless a custom base URL is
    //    present (which indicates a proxy that needs the key for auth).
    const stripped: string[] = [];
    if (def.id === 'claude') {
      const hasBaseUrl = Object.keys(env).some(
        (k) => k.toUpperCase() === 'ANTHROPIC_BASE_URL' && env[k] != null && env[k] !== '',
      );
      if (!hasBaseUrl) {
        for (const key of Object.keys(env)) {
          if (key.toUpperCase() === 'ANTHROPIC_API_KEY') {
            delete env[key];
            stripped.push(key);
          }
        }
      }
    }

    return { env, stripped };
  } catch {
    // Safety net: never let env composition crash the launcher.
    return { env: { ...process.env }, stripped: [] };
  }
}
