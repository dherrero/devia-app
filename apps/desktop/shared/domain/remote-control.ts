/**
 * Remote-control subsystem types (E-DSK-14).
 *
 * The desktop app can be driven from a messaging platform while it is open,
 * by an embedded controller running in the main process (no external daemon).
 * Telegram is the only integration today; the config shape is intentionally a
 * namespace so future integrations (Slack, Discord, …) slot in beside it
 * without reshaping `DeviaConfig`.
 */

/** Connection state of a remote-control integration, surfaced to the UI. */
export type RemoteControlState =
  /** Integration turned off in settings (or no token/chat configured). */
  | 'disabled'
  /** Controller starting; polling not yet confirmed. */
  | 'connecting'
  /** Bot reachable and polling active. */
  | 'connected'
  /** Token rejected by the platform (401). */
  | 'auth-error'
  /** Network or other recoverable failure; the controller keeps retrying. */
  | 'error';

export interface RemoteControlStatus {
  state: RemoteControlState;
  /** Resolved bot @username when connected (Telegram getMe). */
  botUsername?: string;
  /** Human-readable last-error detail (already platform-sanitised, no secrets). */
  detail?: string;
}

/** Result of validating a bot token without enabling the integration. */
export interface TelegramTestResult {
  ok: boolean;
  botUsername?: string;
  error?: string;
}
