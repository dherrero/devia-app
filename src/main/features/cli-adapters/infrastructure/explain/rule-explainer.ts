import type { ErrorAction, UserFacingError } from '../../../../../shared/domain/user-facing-error';
import { redactSecrets } from './nested-error';
import { explainProviderFailure } from './provider-failure';
import type { AgentExplainer, ExplainContext } from './types';

/** One reading of a known failure of an agent's CLI. First matching rule wins. */
export interface ExplainRule {
  readonly pattern: RegExp;
  readonly code: string;
  readonly title: string;
  readonly cause: string;
  readonly actions?: (ctx: ExplainContext) => readonly ErrorAction[];
}

const SETTINGS: ErrorAction = { kind: 'open_settings', section: 'execution' };
export const loginAction = (ctx: ExplainContext): ErrorAction => ({ kind: 'login', agentId: ctx.agentId });
export const settingsAction = (): ErrorAction => SETTINGS;

/**
 * Builds an explainer from a rule table. With `providerFallback`, anything the
 * table does not know is tried against the shared provider-failure reading
 * (agents whose model talks to an OpenAI-style API).
 */
export function ruleExplainer(
  label: string,
  rules: readonly ExplainRule[],
  options: { providerFallback?: boolean } = {},
): AgentExplainer {
  return (input) => {
    const raw = input.classified.rawMessage;
    for (const rule of rules) {
      if (!rule.pattern.test(raw)) continue;
      const error: UserFacingError = {
        code: rule.code,
        params: { agent: label },
        title: rule.title,
        cause: rule.cause,
        actions: [...(rule.actions?.(input.ctx) ?? []), { kind: 'copy_details' }],
        details: redactSecrets(raw),
      };
      return error;
    }
    return options.providerFallback === true ? explainProviderFailure(input, label) : null;
  };
}
