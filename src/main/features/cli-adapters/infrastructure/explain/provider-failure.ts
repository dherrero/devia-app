import type { ErrorAction, UserFacingError } from '../../../../../shared/domain/user-facing-error';
import { extractNestedError, redactSecrets } from './nested-error';
import type { ExplainInput } from './types';

/** Credential variable each provider's SDK reads on its own. */
const ENV_BY_PROVIDER: Readonly<Record<string, string>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

const PROVIDER_WORDS = /\b(openai|anthropic|openrouter|gemini|google|deepseek|xai|groq|mistral|ollama)\b/i;

function detectProvider(raw: string, nestedProvider: string | undefined): string | undefined {
  if (nestedProvider !== undefined) return nestedProvider;
  return PROVIDER_WORDS.exec(raw)?.[1]?.toLowerCase();
}

const SETTINGS: ErrorAction = { kind: 'open_settings', section: 'execution' };
const COPY: ErrorAction = { kind: 'copy_details' };

/**
 * Failures of agents that talk to a provider chosen by the model (PI, OpenCode…):
 * a bad key, quota, a missing model, overload. Returns `null` for anything else
 * so the caller can defer to the generic mapping.
 */
export function explainProviderFailure(
  { classified, ctx }: ExplainInput,
  agentLabel: string,
): UserFacingError | null {
  const raw = classified.rawMessage;
  const nested = extractNestedError(raw);
  const text = `${raw} ${nested?.message ?? ''}`;
  const code = nested?.code ?? '';
  const status = nested?.statusCode;
  const provider = detectProvider(text, nested?.provider);
  const envVar = provider !== undefined ? ENV_BY_PROVIDER[provider] : undefined;
  const inherited = envVar !== undefined && ctx.inheritedProviderEnv.includes(envVar) ? envVar : undefined;
  const model = ctx.configuredModel;
  const details = redactSecrets(raw);

  const params = (extra: Record<string, string | number> = {}): Record<string, string | number> => ({
    agent: agentLabel,
    ...(provider !== undefined && { provider }),
    ...(model !== undefined && { model }),
    ...extra,
  });
  const make = (c: string, title: string, cause: string, actions: readonly ErrorAction[], extra?: Record<string, string | number>): UserFacingError => ({
    code: c,
    params: params(extra),
    title,
    cause,
    actions: [...actions, COPY],
    details,
  });
  const providerName = provider ?? 'el proveedor';

  if (
    status === 401 ||
    /invalid_api_key|incorrect api key|invalid api key|api key (is )?(not (set|found)|missing|required|invalid)/i.test(text)
  ) {
    const why =
      model === undefined
        ? `${agentLabel} no tiene un modelo elegido en Devia, así que usó el suyo por defecto (${providerName}).`
        : `${agentLabel} usa el modelo ${model} (${providerName}).`;
    const key =
      inherited !== undefined
        ? ` La clave heredada de la variable de entorno ${inherited} no es válida: corrígela o quítala.`
        : ` Revisa la clave de ${providerName}.`;
    const actions: ErrorAction[] = model === undefined ? [{ kind: 'pick_model' }, SETTINGS] : [SETTINGS];
    return make('invalid_provider_key', `La clave de ${providerName} no es válida`, why + key, actions, {
      ...(inherited !== undefined && { envVar: inherited }),
    });
  }
  if (/insufficient_quota|exceeded your current quota|billing|credit balance|payment required/i.test(text) || status === 402) {
    return make('provider_quota', `Sin saldo o cuota en ${providerName}`, `${providerName} rechaza la petición por cuota o saldo agotado. Revisa tu plan o cambia de modelo.`, [{ kind: 'pick_model' }, SETTINGS]);
  }
  if (status === 429 || /rate[_ ]limit|too many requests/i.test(text) || classified.reason === 'rate_limited') {
    return make('rate_limited', 'Demasiadas peticiones', `${providerName} está limitando las peticiones. Espera un momento y reintenta.`, [{ kind: 'retry' }]);
  }
  if (status === 404 || /model_not_found|model not found|does not exist|no such model|unknown model/i.test(text)) {
    const which = model !== undefined ? ` (${model})` : '';
    return make('model_unavailable', 'Modelo no disponible', `El modelo${which} no existe o tu cuenta no tiene acceso. Elige otro en Ajustes › Ejecución.`, [{ kind: 'pick_model' }, SETTINGS]);
  }
  if (/context_length_exceeded|maximum context|context (length|window)/i.test(text)) {
    return make('context_too_large', 'La conversación es demasiado larga', 'El historial supera el contexto del modelo. Empieza una sesión nueva o elige un modelo con más contexto.', []);
  }
  if (/no provider configured/i.test(text)) {
    return make('no_provider', `${agentLabel} no tiene proveedor configurado`, `Configura un proveedor en ${agentLabel} o elige un modelo en Ajustes › Ejecución.`, [SETTINGS]);
  }
  if (/no endpoints available matching your (guardrail|data policy)/i.test(text)) {
    return make('openrouter_policy', 'OpenRouter bloquea este modelo por tu política de datos', 'Ajusta tu privacidad en https://openrouter.ai/settings/privacy o elige otro modelo.', [{ kind: 'pick_model' }]);
  }
  if (/ollama.*not running|connection refused.*11434|ECONNREFUSED[^\n]*11434/i.test(text)) {
    return make('ollama_down', 'Ollama no está en marcha', 'Arráncalo con `ollama serve` y vuelve a intentarlo.', [{ kind: 'retry' }]);
  }
  if ((status !== undefined && status >= 500) || /overloaded|service unavailable|bad gateway|\b5\d\d\b.*error/i.test(text) || classified.reason === 'retry') {
    return make('transient', 'Fallo temporal del proveedor', `${providerName} o la red han fallado de forma transitoria. Reintenta en un momento.`, [{ kind: 'retry' }]);
  }
  return null;
}
