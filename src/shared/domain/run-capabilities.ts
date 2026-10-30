/**
 * Per-run permission descriptor (REV-AGENT-CORE-005).
 *
 * Minted by `RunInstructionUseCase` for every spawn. Threaded through
 * `def.buildExtraArgs(opts.capabilities)` so each adapter can compose the
 * right argv (e.g. Claude's `--disallowedTools` flag) without the use case
 * needing to know which CLI it's launching.
 *
 * Distinct from `RuntimeAgentDef` static defaults: a capability descriptor is
 * specific to ONE run. Two runs with the same agent can carry different
 * descriptors when the user switches mode (REV-AGENT-CORE-006).
 *
 * Future MCP work (REV-AGENT-CORE-004) will read `allowedMcpServerIds` to
 * filter which servers are exposed to the run.
 */

import type { RunId } from './agent';

/** User-facing mode that drives the default capability shape (REV-AGENT-CORE-006). */
export type RunMode = 'plan' | 'apply' | 'apply-yolo';

export interface RunCapabilities {
  /** Bound to the originating run for traceability. */
  runId: RunId;
  /** User-selected mode at the time of dispatch. */
  mode: RunMode;
  /**
   * Allowlist of tools the agent may invoke. `undefined` means "all tools the
   * adapter exposes by default". Conflict with `disallowedTools` resolves
   * denylist-wins.
   */
  allowedTools?: string[];
  /**
   * Denylist applied on top of the allowlist (and on top of the adapter's
   * static defaults).
   */
  disallowedTools?: string[];
  /**
   * Allowlist of MCP server ids visible to this run. `undefined` means "all
   * enabled servers". Consumed by REV-AGENT-CORE-004.
   */
  allowedMcpServerIds?: string[];
  /**
   * Epoch ms after which the descriptor is no longer authoritative — the run
   * is expected to have terminated by then. Used for telemetry/audit only;
   * does not actively enforce a kill.
   */
  expiresAt: number;
}

/**
 * Build the default capability descriptor for a fresh run. The mode drives the
 * denylist:
 *   - plan       → block any file-mutating tool
 *   - apply      → no plan-mode restriction; adapter denylist still applies
 *   - apply-yolo → no restrictions beyond the adapter's static defaults
 *
 * `defaultDisallowedTools` will be supplied by the adapter once
 * REV-AGENT-CORE-007 lands; until then the use case passes the legacy
 * Claude-only `['WebSearch','WebFetch']` literal so behaviour is identical.
 *
 * `ttlMs` defaults to 30 minutes which is well past any normal run lifetime.
 */
export function buildDefaultCapabilities(
  runId: RunId,
  mode: RunMode,
  options: {
    defaultDisallowedTools?: readonly string[];
    ttlMs?: number;
  } = {},
): RunCapabilities {
  const baseDeny = [...(options.defaultDisallowedTools ?? [])];
  const planExtra = mode === 'plan' ? ['Edit', 'Write', 'MultiEdit', 'Bash'] : [];
  const merged = dedupe([...baseDeny, ...planExtra]);
  const cap: RunCapabilities = {
    runId,
    mode,
    expiresAt: Date.now() + (options.ttlMs ?? 30 * 60 * 1_000),
  };
  if (merged.length > 0) cap.disallowedTools = merged;
  return cap;
}

/**
 * Resolve the final tool denylist for `def.buildExtraArgs`. Denylist always
 * wins over allowlist on conflict (FR §15).
 */
export function resolveDisallowedTools(cap: RunCapabilities): string[] {
  return dedupe(cap.disallowedTools ?? []);
}

/**
 * Sanitise a user-supplied tool name (REV-AGENT-CORE-007 §11 TR2). Returns
 * `null` for any input that doesn't pass the strict shape check:
 *   - non-empty trimmed string
 *   - ≤ 64 characters
 *   - alphanumeric + `-` + `_` only
 *
 * Used at the config-write boundary to keep the persisted policy clean and at
 * the argv-compose boundary as defence-in-depth.
 */
export function sanitiseToolName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Sanitise an entire denylist/allowlist input from user config. Drops invalid
 * entries silently (callers may log a warning if they want).
 */
export function sanitiseToolNames(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  const out: string[] = [];
  for (const n of names) {
    const safe = sanitiseToolName(n);
    if (safe !== null) out.push(safe);
  }
  return dedupe(out);
}

function dedupe(arr: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
