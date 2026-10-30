/**
 * Structured taxonomy of CLI-spawned agent errors, ported from
 * `hermes-agent/agent/error_classifier.py` (ticket E-DSK-09 #262).
 *
 * Whereas hermes models the CAUSE of an error (auth, billing, timeout, …),
 * this taxonomy models the RECOVERY ACTION the renderer should take.
 * Multiple causes collapse onto the same action — e.g. a 402 (billing
 * exhausted) and a 429 with `Retry-After: 86400` both surface as
 * `quota_exceeded`, because the user-visible UX is identical: show the
 * upgrade toast and stop retrying.
 *
 * Why a recovery-oriented union: devia is a desktop client, not a fleet
 * orchestrator. The renderer doesn't need to know whether the underlying
 * status code was 401 vs 403 vs an OAuth refresh-token expiry; it needs
 * to know "send the user to settings to log in again". Hermes' richer
 * taxonomy survives inside the matcher implementations, which read the
 * specific cause and decide the action.
 */
export type FailoverReason =
  /** Transient — try again with backoff. Network timeouts, 5xx, generic
   *  "please retry" hints. */
  | 'retry'
  /** Credential is plausibly invalid; rotating to a fallback key would
   *  help. Used when the user has multiple keys configured. Today devia
   *  has one key per provider; this is reserved for the multi-key
   *  future. */
  | 'rotate_credential'
  /** Try a different provider entirely (e.g. Claude → Codex). Reserved
   *  for the failover ladder; today devia surfaces this as an actionable
   *  hint, no automatic fallback. */
  | 'fallback_provider'
  /** Context window exceeded — the renderer should call the compressor
   *  (ticket #263 for Pro) or show the upgrade toast (Free). */
  | 'compress_context'
  /** Authentication failed — user must re-auth (login flow / API key). */
  | 'auth_required'
  /** Billing/quota exhausted — paid plan needed. Upgrade toast (#258). */
  | 'quota_exceeded'
  /** Rate-limited but transient — render a cooldown indicator. */
  | 'rate_limited'
  /** The requested model is missing or deprecated — switch model. */
  | 'model_unavailable'
  /** Matcher could not recognise the error. Renderer shows the raw
   *  message with a "report" CTA so users can submit unknown patterns
   *  that we can later teach the matcher about. */
  | 'unrecoverable';

/**
 * Result of running a raw error string (typically a stderr tail or a
 * structured JSON error event) through the per-CLI matcher pipeline.
 *
 * `rawMessage` is preserved verbatim so the renderer can show it when
 * the reason is `unrecoverable` and so audit logs retain the original
 * for postmortem analysis.
 */
export interface ClassifiedError {
  readonly reason: FailoverReason;
  /** Verbatim error text the matcher saw. May be truncated to ~4 KB
   *  upstream of the classifier — the matcher itself does not truncate. */
  readonly rawMessage: string;
  /** Which CLI produced the error (`claude`, `codex`, `gemini`, …).
   *  Drives the matcher selection and is preserved for downstream
   *  routing (audit log, settings deep links). */
  readonly cliId: string;
  /** Optional short hint surfaced in the toast — e.g. "Run `claude login`"
   *  or "Configure ANTHROPIC_API_KEY in Settings". */
  readonly hint?: string;
  /** When the upstream API supplied a `Retry-After` header or equivalent,
   *  the parsed value in seconds. Renderer uses this to drive the
   *  cooldown indicator for `rate_limited`. */
  readonly retryAfterSeconds?: number;
}

/**
 * Maps a {@link FailoverReason} onto the legacy 5-value
 * `ErrorClassification` union the rest of devia (event payloads,
 * persisted messages, chat ports) still consumes. Keeping that union
 * stable means every consumer outside the matcher pipeline can continue
 * to branch on `'auth' | 'transient' | 'prompt-too-large' | 'crash' |
 * 'unknown'` while new code reaches for the richer
 * {@link ClassifiedError}.
 *
 * The mapping is intentionally lossy — multiple recovery actions
 * collapse to the same legacy value because the legacy consumers can't
 * tell them apart.
 */
export function toLegacyClassification(
  reason: FailoverReason,
): 'transient' | 'auth' | 'prompt-too-large' | 'crash' | 'unknown' {
  switch (reason) {
    case 'auth_required':
    case 'rotate_credential':
      return 'auth';
    case 'compress_context':
      return 'prompt-too-large';
    case 'retry':
    case 'rate_limited':
      return 'transient';
    case 'quota_exceeded':
    case 'model_unavailable':
    case 'fallback_provider':
      return 'crash';
    case 'unrecoverable':
    default:
      return 'unknown';
  }
}
