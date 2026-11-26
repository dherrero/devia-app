/**
 * Cross-agent workers config (S-56). Off by default: every worker is a full CLI
 * run that spends that agent's own quota, so the user opts in knowingly.
 */
export interface CrossAgentConfig {
  enabled: boolean;
  /** Workers running at once, GLOBAL across the app (not per parent). */
  maxConcurrent: number;
  /** Workers one controller turn may launch. */
  maxPerTurn: number;
  /** Kill a worker that has not finished after this long. */
  defaultTimeoutSec: number;
}

export const DEFAULT_CROSS_AGENT_CONFIG: Readonly<CrossAgentConfig> = Object.freeze({
  enabled: false,
  maxConcurrent: 3,
  maxPerTurn: 8,
  defaultTimeoutSec: 1800,
});

export const MAX_CROSS_AGENT_CONCURRENCY = 8;

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n >= 1 ? n : fallback;
}

/** Fill gaps and repair a persisted (possibly absent or malformed) block. */
export function normalizeCrossAgentConfig(raw: unknown): CrossAgentConfig {
  const p = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    enabled: typeof p['enabled'] === 'boolean' ? p['enabled'] : DEFAULT_CROSS_AGENT_CONFIG.enabled,
    maxConcurrent: Math.min(
      positiveInt(p['maxConcurrent'], DEFAULT_CROSS_AGENT_CONFIG.maxConcurrent),
      MAX_CROSS_AGENT_CONCURRENCY,
    ),
    maxPerTurn: positiveInt(p['maxPerTurn'], DEFAULT_CROSS_AGENT_CONFIG.maxPerTurn),
    defaultTimeoutSec: positiveInt(p['defaultTimeoutSec'], DEFAULT_CROSS_AGENT_CONFIG.defaultTimeoutSec),
  };
}
