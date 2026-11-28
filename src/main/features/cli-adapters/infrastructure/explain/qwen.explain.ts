import { loginAction, ruleExplainer, settingsAction } from './rule-explainer';

/** Rules from Qwen's matchers (DashScope); unverified against a live failure. */
export const qwenExplainer = ruleExplainer(
  'Qwen',
  [
    {
      pattern: /DASHSCOPE_API_KEY|QWEN_API_KEY|InvalidApiKey|InvalidParameter\.Auth/i,
      code: 'auth_required',
      title: 'La clave de Qwen no es válida',
      cause: 'Define una clave DashScope válida (DASHSCOPE_API_KEY) en Ajustes › Ejecución.',
      actions: (ctx) => [loginAction(ctx), settingsAction()],
    },
    {
      pattern: /账户.*余额|余额不足/,
      code: 'provider_quota',
      title: 'Saldo de DashScope agotado',
      cause: 'Recarga tu cuenta de DashScope para seguir usando Qwen.',
      actions: () => [settingsAction()],
    },
    {
      pattern: /Throttling\.User|RequestLimitExceeded/i,
      code: 'rate_limited',
      title: 'Demasiadas peticiones a Qwen',
      cause: 'DashScope limita las peticiones. Espera un momento y reintenta.',
      actions: () => [{ kind: 'retry' }],
    },
    {
      pattern: /超过最大长度|上下文长度/,
      code: 'context_too_large',
      title: 'La conversación es demasiado larga',
      cause: 'El historial supera el contexto del modelo. Empieza una sesión nueva.',
    },
  ],
  { providerFallback: true },
);
