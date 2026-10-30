import { makeChatError } from '../../../../shared/domain/chat-error';
import type { ChatError } from '../../../../shared/domain/chat-error';
import { classify } from '../../cli-adapters/infrastructure/error-classifier';

/**
 * Auth-error classifier.
 *
 * Delegates the matching to the unified per-CLI taxonomy
 * (`cli-adapters/infrastructure/error-classifier`, ticket #262); this
 * module only owns the **deep-link recovery hint** lookup table that
 * routes the user to the right Settings page when an `auth_required`
 * outcome surfaces.
 *
 * Before #262 this file maintained its own per-provider matcher list.
 * Keeping two parallel matchers in sync proved brittle (e.g. a new
 * Anthropic 401 wording landed in `error-classifier.ts` but not here,
 * so users got generic toasts instead of the settings deep link).
 * Centralising the matching in one place means the deep link follows
 * automatically whenever a new pattern is added.
 */

/**
 * The deep link surfaced in {@link ChatError.recoveryHint}: the agent's own
 * Settings page. One rule for every agent, so a new agent never lacks it.
 */
function recoveryHintFor(providerId: string): string {
  return `devia://settings/agents/${providerId}`;
}

/**
 * Inspects a stderr tail and returns a typed `AUTH_REQUIRED`
 * {@link ChatError} when the unified classifier reports
 * `reason === 'auth_required'` (or `'rotate_credential'` — both surface
 * to the user as "log in again"), or `undefined` otherwise.
 *
 * Pure function — no I/O, no side effects. Callers route the returned
 * `ChatError` through the renderer's existing toast pipeline.
 */
export function classifyAuthError(
  providerId: string,
  stderrTail: string,
): ChatError | undefined {
  const classified = classify(providerId, stderrTail);
  if (classified.reason !== 'auth_required' && classified.reason !== 'rotate_credential') {
    return undefined;
  }
  const recoveryHint = recoveryHintFor(providerId);
  return makeChatError(
    'AUTH_REQUIRED',
    `Authentication required for ${providerId}`,
    {
      recoverable: true,
      retryable: false,
      ...(recoveryHint !== undefined ? { recoveryHint } : {}),
    },
  );
}
