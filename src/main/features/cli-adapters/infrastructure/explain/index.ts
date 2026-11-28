import type { ClassifiedError } from '../../../../../shared/domain/cli-errors';
import type { UserFacingError } from '../../../../../shared/domain/user-facing-error';
import { hermesExplainer, kimiExplainer } from './acp-agents.explain';
import { claudeExplainer } from './claude.explain';
import { codexExplainer } from './codex.explain';
import { copilotExplainer } from './copilot.explain';
import { deepseekExplainer } from './deepseek.explain';
import { cursorAgentExplainer } from './cursor-agent.explain';
import { geminiExplainer } from './gemini.explain';
import { genericExplain } from './generic';
import { grokExplainer } from './grok.explain';
import { opencodeExplainer } from './opencode.explain';
import { piExplainer } from './pi.explain';
import { qoderExplainer } from './qoder.explain';
import { qwenExplainer } from './qwen.explain';
import { redactSecrets } from './nested-error';
import type { AgentExplainer, ExplainContext } from './types';

export type { AgentExplainer, ExplainContext, ExplainInput } from './types';
export { extractNestedError, redactSecrets } from './nested-error';

/** Per-agent readings, keyed by CLI id. An agent without one uses the generic mapping. */
const EXPLAINERS: Readonly<Record<string, AgentExplainer>> = {
  claude: claudeExplainer,
  codex: codexExplainer,
  gemini: geminiExplainer,
  'cursor-agent': cursorAgentExplainer,
  copilot: copilotExplainer,
  opencode: opencodeExplainer,
  pi: piExplainer,
  qwen: qwenExplainer,
  deepseek: deepseekExplainer,
  qoder: qoderExplainer,
  grok: grokExplainer,
  kimi: kimiExplainer,
  hermes: hermesExplainer,
};

/** Remote (Telegram) runs get the text only: there is no UI to act on. */
function forOrigin(error: UserFacingError, ctx: ExplainContext): UserFacingError {
  return ctx.origin === 'remote' && error.actions.length > 0 ? { ...error, actions: [] } : error;
}

/**
 * Turns a classified agent error into what the user is shown (S-54). Total:
 * it never throws, and a failing agent explainer falls back to the generic one.
 */
export function explainError(cliId: string, classified: ClassifiedError, ctx: ExplainContext): UserFacingError {
  const input = { classified, ctx };
  try {
    const own = EXPLAINERS[cliId]?.(input) ?? null;
    if (own !== null) return forOrigin(own, ctx);
  } catch {
    /* fall through to the generic mapping */
  }
  try {
    return forOrigin(genericExplain(input), ctx);
  } catch {
    return {
      code: 'unknown',
      title: 'El agente ha fallado',
      cause: 'Devia no pudo interpretar este error.',
      actions: [],
      details: redactSecrets(String(classified?.rawMessage ?? '')),
    };
  }
}
