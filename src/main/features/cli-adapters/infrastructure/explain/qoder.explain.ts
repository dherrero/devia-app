import { loginAction, ruleExplainer, settingsAction } from './rule-explainer';

/** Rules from Qoder's matchers; unverified against a live failure. */
export const qoderExplainer = ruleExplainer('Qoder', [
  {
    pattern: /qoder.*(login|auth).*(required|expired)/i,
    code: 'auth_required',
    title: 'Qoder no tiene la sesión iniciada',
    cause: 'Ejecuta `qoder login` y vuelve a intentarlo.',
    actions: (ctx) => [loginAction(ctx)],
  },
  {
    pattern: /qoder.*quota/i,
    code: 'provider_quota',
    title: 'Cuota de Qoder agotada',
    cause: 'Tu plan de Qoder no admite más uso ahora. Revisa tu plan o espera al reinicio.',
    actions: () => [settingsAction()],
  },
]);
