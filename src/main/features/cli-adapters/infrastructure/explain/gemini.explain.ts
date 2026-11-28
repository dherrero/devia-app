import { loginAction, ruleExplainer, settingsAction } from './rule-explainer';

/** Rules from Gemini's matchers (Google API status names); unverified against a live failure. */
export const geminiExplainer = ruleExplainer('Gemini', [
  {
    pattern: /GEMINI_API_KEY|GOOGLE_API_KEY|PERMISSION_DENIED|UNAUTHENTICATED/i,
    code: 'auth_required',
    title: 'Gemini no está autenticado',
    cause: 'Inicia sesión en Gemini CLI o define GEMINI_API_KEY (o GOOGLE_API_KEY) en Ajustes › Ejecución.',
    actions: (ctx) => [loginAction(ctx), settingsAction()],
  },
  {
    pattern: /quota.*exceeded|exceeded.*quota|billing/i,
    code: 'provider_quota',
    title: 'Cuota de Gemini agotada',
    cause: 'Tu cuota o facturación de Google no permite más peticiones ahora. Revisa tu plan o espera al reinicio.',
    actions: () => [settingsAction()],
  },
  {
    pattern: /RESOURCE_EXHAUSTED|too many requests|\b429\b/i,
    code: 'rate_limited',
    title: 'Demasiadas peticiones a Gemini',
    cause: 'Google limita las peticiones. Espera un momento y reintenta.',
    actions: () => [{ kind: 'retry' }],
  },
  {
    pattern: /token count.*exceeds.*maximum|total tokens.*exceed/i,
    code: 'context_too_large',
    title: 'La conversación es demasiado larga',
    cause: 'El historial supera el contexto del modelo. Empieza una sesión nueva.',
  },
  {
    pattern: /DEADLINE_EXCEEDED|UNAVAILABLE/i,
    code: 'transient',
    title: 'Gemini no responde',
    cause: 'Fallo temporal del servicio. Reintenta en un momento.',
    actions: () => [{ kind: 'retry' }],
  },
]);
