import { loginAction, ruleExplainer, settingsAction } from './rule-explainer';

/** Rules from DeepSeek's matchers; unverified against a live failure. */
export const deepseekExplainer = ruleExplainer(
  'DeepSeek',
  [
    {
      pattern: /DEEPSEEK_API_KEY|deepseek.*invalid (token|key)/i,
      code: 'auth_required',
      title: 'La clave de DeepSeek no es válida',
      cause: 'Define una clave válida (DEEPSEEK_API_KEY) en Ajustes › Ejecución.',
      actions: (ctx) => [loginAction(ctx), settingsAction()],
    },
    {
      pattern: /deepseek.*insufficient.*balance/i,
      code: 'provider_quota',
      title: 'Saldo de DeepSeek agotado',
      cause: 'Añade crédito a tu cuenta de DeepSeek.',
      actions: () => [settingsAction()],
    },
    {
      pattern: /deepseek-chat.*not (available|enabled)/i,
      code: 'model_unavailable',
      title: 'Modelo de DeepSeek no disponible',
      cause: 'Elige otro modelo en Ajustes › Ejecución.',
      actions: () => [{ kind: 'pick_model' }, settingsAction()],
    },
  ],
  { providerFallback: true },
);
