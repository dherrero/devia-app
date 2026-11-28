import type { DeviaConfig } from '../../../../shared/domain/config';
import type { ExplainContext } from '../../cli-adapters/infrastructure/explain';

/** Variables that make an agent pick a provider on its own. Names only are ever surfaced. */
const PROVIDER_ENV_NAMES: readonly string[] = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'DASHSCOPE_API_KEY',
  'MOONSHOT_API_KEY',
];

export interface ExplainContextInput {
  readonly agentId: string;
  readonly cfg: DeviaConfig;
  readonly origin: 'renderer' | 'remote';
  /** Defaults to `process.env`; injectable for tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly resetsAt?: number;
}

/**
 * What the run knows beyond the error text, for `explainError` (S-54). It only
 * READS config and environment; secret values never enter the result.
 */
export function buildExplainContext(input: ExplainContextInput): ExplainContext {
  const { agentId, cfg, origin, resetsAt } = input;
  const env = input.env ?? process.env;
  const own = cfg.agentCliEnv?.[agentId] ?? {};
  const inheritedProviderEnv = PROVIDER_ENV_NAMES.filter(
    (name) => (env[name] ?? '').length > 0 || (own[name] ?? '').length > 0,
  );
  const model = cfg.agentModels?.[agentId]?.model;
  return {
    agentId,
    ...(model !== undefined && model.length > 0 && { configuredModel: model }),
    inheritedProviderEnv,
    autoContinueEnabled: cfg.autoContinueSessions?.[agentId] === true,
    ...(resetsAt !== undefined && { resetsAt }),
    origin,
  };
}
