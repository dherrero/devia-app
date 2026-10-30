import type { ErrorClassification } from '../../../../shared/domain/agent-event';
import type {
  ClassifiedError,
  FailoverReason,
} from '../../../../shared/domain/cli-errors';
import { toLegacyClassification } from '../../../../shared/domain/cli-errors';
import {
  GENERIC_RULES,
  firstMatch,
  parseRetryAfter,
  type MatcherRule,
} from './matchers/shared';
import { CLAUDE_RULES } from './matchers/claude.matchers';
import { CODEX_RULES } from './matchers/codex.matchers';
import { GEMINI_RULES } from './matchers/gemini.matchers';
import { OPENCODE_RULES } from './matchers/opencode.matchers';
import { CURSOR_AGENT_RULES } from './matchers/cursor-agent.matchers';
import { COPILOT_RULES } from './matchers/copilot.matchers';
import { QWEN_RULES } from './matchers/qwen.matchers';
import { DEEPSEEK_RULES } from './matchers/deepseek.matchers';
import { QODER_RULES } from './matchers/qoder.matchers';
import { GROK_RULES } from './matchers/grok.matchers';

/**
 * Per-CLI matcher tables ported from hermes' provider classifications
 * (E-DSK-09 #262). Each CLI's rules run first, then {@link GENERIC_RULES}
 * picks up provider-agnostic strings (HTTP status codes, common english
 * patterns). Unrecognised messages collapse to `unrecoverable`.
 *
 * The map is keyed by the CLI ids registered in
 * `cli-adapters/infrastructure/defs/`. A missing key uses generic rules
 * only — useful for the future agent12 case the registry already plans
 * for (see ticket #264).
 */
const RULES_BY_CLI: Readonly<Record<string, readonly MatcherRule[]>> = {
  claude: CLAUDE_RULES,
  codex: CODEX_RULES,
  gemini: GEMINI_RULES,
  opencode: OPENCODE_RULES,
  'cursor-agent': CURSOR_AGENT_RULES,
  copilot: COPILOT_RULES,
  qwen: QWEN_RULES,
  deepseek: DEEPSEEK_RULES,
  qoder: QODER_RULES,
  grok: GROK_RULES,
};

/**
 * Classify a raw error string into a structured {@link ClassifiedError}.
 *
 * `raw` may be a stderr tail, a JSON-encoded `error` event from the
 * stream parser, or a synthetic message from the launcher (e.g. spawn
 * ENOENT). The classifier does not own the truncation policy — callers
 * pass a bounded payload.
 *
 * Never throws. Unrecognised messages return
 * `{ reason: 'unrecoverable', rawMessage: raw, cliId }` so callers can
 * always pattern-match on the result.
 */
export function classify(cliId: string, raw: string): ClassifiedError {
  const message = typeof raw === 'string' ? raw : String(raw ?? '');
  if (!message) {
    return { reason: 'unrecoverable', rawMessage: '', cliId };
  }
  try {
    const cliRules = RULES_BY_CLI[cliId] ?? [];
    const match = firstMatch(message, cliRules) ?? firstMatch(message, GENERIC_RULES);
    if (!match) {
      return { reason: 'unrecoverable', rawMessage: message, cliId };
    }
    const retryAfterSeconds = parseRetryAfter(message);
    return {
      reason: match.reason,
      rawMessage: message,
      cliId,
      ...(match.hint !== undefined && { hint: match.hint }),
      ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
    };
  } catch {
    return { reason: 'unrecoverable', rawMessage: message, cliId };
  }
}

/**
 * Convenience accessor for callsites that only need the high-level
 * failover decision (e.g. retry-loop wrappers). Equivalent to
 * `classify(cliId, raw).reason`.
 */
export function classifyReason(cliId: string, raw: string): FailoverReason {
  return classify(cliId, raw).reason;
}

/**
 * Legacy entry point — preserved so the existing `cli-launcher.ts` and
 * `run-instruction.use-case.ts` callsites compile unchanged. New code
 * should call {@link classify} and consume the richer
 * {@link ClassifiedError}.
 *
 * Maps the new {@link FailoverReason} onto the existing 5-value
 * `ErrorClassification` union via {@link toLegacyClassification}.
 *
 * The historic underscore on `_agentId` is dropped because the new
 * implementation uses the cliId to pick the matcher table.
 */
export function classifyError(agentId: string, stderrTail: string): ErrorClassification {
  return toLegacyClassification(classify(agentId, stderrTail).reason);
}
