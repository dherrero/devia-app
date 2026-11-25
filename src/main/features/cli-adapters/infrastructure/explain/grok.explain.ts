import { loginAction, ruleExplainer, settingsAction } from './rule-explainer';

/** Rules from Grok's matchers (xAI); unverified against a live failure. */
export const grokExplainer = ruleExplainer(
  'Grok',
  [
    {
      pattern: /GROK_API_KEY|API key required|x\.ai.*(unauthor|forbidden)|invalid.*xai/i,
      code: 'auth_required',
      title: 'La clave de Grok no es válida',
      cause: 'Define una clave de xAI válida (GROK_API_KEY) en Ajustes › Ejecución.',
      actions: (ctx) => [loginAction(ctx), settingsAction()],
    },
  ],
  { providerFallback: true },
);
