import { loginAction, ruleExplainer, settingsAction, type ExplainRule } from './rule-explainer';

/**
 * Kimi and Hermes speak ACP: a failure reaches Devia as the JSON-RPC error's
 * message text. No recorded logs yet, so the patterns are the ACP-standard
 * "authentication required" family and unverified against a live failure.
 */
const ACP_RULES: readonly ExplainRule[] = [
  {
    pattern: /auth(entication|orization)?[^\n]{0,24}required|not (logged in|authenticated)|-32000\b|please (log ?in|sign in)/i,
    code: 'auth_required',
    title: 'El agente no tiene la sesión iniciada',
    cause: 'Inicia sesión en el agente desde su CLI y vuelve a intentarlo.',
    actions: (ctx) => [loginAction(ctx)],
  },
  {
    pattern: /spawn [^\n]* ENOENT|command not found|no such file or directory/i,
    code: 'not_installed',
    title: 'No se encuentra el agente',
    cause: 'El ejecutable del agente no está instalado o no está en el PATH. Instálalo y revisa Ajustes › Ejecución.',
    actions: () => [settingsAction()],
  },
];

export const kimiExplainer = ruleExplainer('Kimi', ACP_RULES, { providerFallback: true });
export const hermesExplainer = ruleExplainer('Hermes', ACP_RULES, { providerFallback: true });
