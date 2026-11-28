import { loginAction, ruleExplainer, settingsAction } from './rule-explainer';

/** Rules from Codex's matchers; no recorded logs yet, so they are unverified against a live failure. */
export const codexExplainer = ruleExplainer(
  'Codex',
  [
    {
      pattern: /user cancelled MCP tool call/i,
      code: 'codex_mcp_sandbox',
      title: 'Codex ha cancelado una herramienta MCP',
      cause: 'Con el sandbox gestionado de Codex (modo apply en macOS/Linux) las herramientas MCP de Devia se cancelan. Prueba en modo apply-yolo o en plan.',
    },
    {
      pattern: /OPENAI_API_KEY|set your OPENAI_API_KEY|not logged in|codex login/i,
      code: 'auth_required',
      title: 'Codex no está autenticado',
      cause: 'Inicia sesión con `codex login` o define OPENAI_API_KEY en Ajustes › Ejecución.',
      actions: (ctx) => [loginAction(ctx), settingsAction()],
    },
    {
      pattern: /reconnecting|timeout waiting for child process/i,
      code: 'transient',
      title: 'Codex perdió la conexión',
      cause: 'Fallo temporal de red o del proveedor. Reintenta en un momento.',
      actions: () => [{ kind: 'retry' }],
    },
  ],
  { providerFallback: true },
);
