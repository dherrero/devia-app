import type { AuthProbeResult, RuntimeAgentDef } from '../../domain/runtime-agent-def';

/**
 * Re-export for back-compat with the original `AgentAuthProbeResult` name.
 * REV-AGENT-CORE-010 moved the canonical type onto `RuntimeAgentDef` as
 * `AuthProbeResult`; this alias keeps existing imports compiling.
 */
export type AgentAuthProbeResult = AuthProbeResult;

/**
 * Probe the authentication status for a given agent (REV-AGENT-CORE-010).
 *
 * Dispatches to the adapter's own `authProbe` slot if defined. Adapters
 * without a probe return `{ status: 'unknown' }`. This function NEVER throws —
 * every probe failure is mapped to `'unknown'`.
 *
 * Back-compat: callers that still pass a bare `agentId + resolvedBin + env`
 * (no `def`) get `'unknown'` unless a `getDef` resolver is provided. The
 * detection layer was updated in the same change to supply the def directly.
 */
export async function probeAgentAuthStatus(
  def: RuntimeAgentDef | undefined,
  resolvedBin: string,
  env: NodeJS.ProcessEnv,
): Promise<AgentAuthProbeResult> {
  try {
    const probe = def?.authProbe;
    if (typeof probe !== 'function') {
      return { status: 'unknown' };
    }
    const result = await probe(resolvedBin, env);
    return result ?? { status: 'unknown' };
  } catch {
    return { status: 'unknown' };
  }
}
