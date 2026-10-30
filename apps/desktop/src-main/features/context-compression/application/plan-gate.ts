/**
 * Subscription-tier gate consumed by the context compressor (ticket
 * #263). The real `AuthService.hasPlan('pro')` from E-DSK-08 #252 is
 * not on `next_release` yet, so this module exposes a small surface
 * that #252 can later wire into without touching the compressor.
 *
 * Resolution order:
 *   1. `process.env.DEVIA_PLAN` — explicit override useful for tests,
 *      dev sessions and CI fixtures. Accepts `'pro'`, `'free'`,
 *      `'pro-cloud'`, `'enterprise'` (any non-`'free'` value behaves as
 *      Pro for gating purposes today).
 *   2. `'free'` — the safe default. Free is the only plan that surfaces
 *      the upgrade toast; Pro skips the upsell and runs compression.
 *
 * When #252 lands, swap this file's body for a call into
 * `inject(AuthService).currentPlan()` (or its main-process equivalent)
 * and the rest of the compressor pipeline stays unchanged.
 */

export type Plan = 'free' | 'pro' | 'pro-cloud' | 'enterprise';

/**
 * Override hook for tests. Production code should not call this; the
 * env-var override is the public contract.
 */
let _testOverride: Plan | undefined;

/** Test-only: force the plan returned by {@link currentPlan}. Pass
 *  `undefined` to revert to the env-var-driven default. */
export function __setPlanForTest(plan: Plan | undefined): void {
  _testOverride = plan;
}

/** Resolves the user's plan. Cached per-call to keep the gate cheap;
 *  the env-var lookup itself is O(1). */
export function currentPlan(): Plan {
  if (_testOverride !== undefined) return _testOverride;
  const raw = (process.env['DEVIA_PLAN'] ?? '').trim().toLowerCase();
  if (raw === 'pro' || raw === 'pro-cloud' || raw === 'enterprise') return raw as Plan;
  return 'free';
}

/** Boolean accessor matching the AuthService.hasPlan('pro') call shape
 *  E-DSK-08 #252 will expose. Returns true for every paid tier. */
export function hasPlan(target: 'pro'): boolean {
  if (target !== 'pro') return false;
  const plan = currentPlan();
  return plan === 'pro' || plan === 'pro-cloud' || plan === 'enterprise';
}
