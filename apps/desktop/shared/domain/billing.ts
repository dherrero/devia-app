export type BillingMode = 'api' | 'subscription' | 'unknown';

export interface BillingAuthStatus {
  readonly kind: 'logged-in' | 'logged-out' | 'unknown';
}

const API_KEY_BY_AGENT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
  codex: ['OPENAI_API_KEY'],
  gemini: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  copilot: [],
  'cursor-agent': [],
  opencode: [],
  qwen: ['DASHSCOPE_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  qoder: [],
});

export function deriveBillingMode(
  agentId: string,
  envOverrides: Readonly<Record<string, string>> | undefined,
  authStatus: BillingAuthStatus | undefined,
): BillingMode {
  const keys = API_KEY_BY_AGENT[agentId] ?? [];
  const hasApiKey = keys.some((k) => {
    const v = envOverrides?.[k];
    return typeof v === 'string' && v.trim().length > 0;
  });
  if (hasApiKey) return 'api';
  if (authStatus?.kind === 'logged-in') return 'subscription';
  return 'unknown';
}
