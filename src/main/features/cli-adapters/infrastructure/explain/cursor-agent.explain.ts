import { loginAction, ruleExplainer, settingsAction } from './rule-explainer';

/** Rules from Cursor Agent's matchers; unverified against a live failure. */
export const cursorAgentExplainer = ruleExplainer('Cursor', [
  {
    pattern: /not (logged in|signed in)|cursor[- ]login|session.*expired/i,
    code: 'auth_required',
    title: 'Cursor no tiene la sesión iniciada',
    cause: 'Ejecuta `cursor-agent login` y vuelve a intentarlo.',
    actions: (ctx) => [loginAction(ctx)],
  },
  {
    pattern: /cursor.*usage.*limit|pro.*plan.*required/i,
    code: 'provider_quota',
    title: 'Límite de uso de Cursor alcanzado',
    cause: 'Tu plan de Cursor no admite más uso ahora. Mejora el plan o espera al reinicio del ciclo.',
    actions: () => [settingsAction()],
  },
]);
