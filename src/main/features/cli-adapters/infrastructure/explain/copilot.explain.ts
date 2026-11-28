import { loginAction, ruleExplainer } from './rule-explainer';

/** Rules from Copilot's matchers; unverified against a live failure. */
export const copilotExplainer = ruleExplainer('Copilot', [
  {
    pattern: /gh auth (login|status)|github.*not (authenticated|logged)/i,
    code: 'auth_required',
    title: 'GitHub no tiene la sesión iniciada',
    cause: 'Ejecuta `gh auth login` (o `gh copilot setup`) y vuelve a intentarlo.',
    actions: (ctx) => [loginAction(ctx)],
  },
  {
    pattern: /copilot.*(subscription|access).*required|copilot.*not (enabled|available)/i,
    code: 'copilot_access',
    title: 'Copilot no está disponible en tu cuenta',
    cause: 'Hace falta una suscripción de GitHub Copilot activa y habilitada para tu cuenta u organización.',
  },
  {
    pattern: /github.*api.*rate/i,
    code: 'rate_limited',
    title: 'GitHub limita las peticiones',
    cause: 'Espera un momento y reintenta.',
    actions: () => [{ kind: 'retry' }],
  },
]);
