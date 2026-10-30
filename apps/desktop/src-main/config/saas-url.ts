/**
 * Single source of truth for the devia-saas web URL the main process talks
 * to. Read once at module load from `process.env.DEVIA_SAAS_URL` so the
 * value is stable across the app's lifetime; the renderer reads it through
 * the bridge's `saas.baseUrl()` IPC.
 *
 * Empty when the variable is unset: the app then has no SaaS to talk to and
 * the upgrade deep link does nothing.
 *
 * Note: this is the saas WEB origin (used for `/upgrade` deep links and the
 * future auth IDP), not the api origin — those are configured separately
 * inside the synced auth library via `provideAuth({ idpServer, pingUrl })`.
 */
export const DEVIA_SAAS_URL: string =
  process.env['DEVIA_SAAS_URL']?.trim() ?? '';
