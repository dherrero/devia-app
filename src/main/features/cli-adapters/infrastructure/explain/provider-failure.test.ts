import { describe, it, expect } from 'vitest';
import { explainError, type ExplainContext } from './index';
import type { ClassifiedError } from '../../../../../shared/domain/cli-errors';

// Real shapes from ~/.devia-app/logs/agent-cli/{pi,opencode} (key already masked by the provider).
const PI_401 =
  'OpenAI API error (401): {"code":"invalid_api_key","message":"Incorrect API key provided: key_vwqb********MBi2. You can find your API key at https://platform.openai.com/account/api-keys.","param":null,"type":"invalid_request_error"}';
const OPENCODE_401 =
  'Incorrect API key provided: key_vwqb********MBi2. You can find your API key at https://platform.openai.com/account/api-keys.';

const ctx = (agentId: string, over: Partial<ExplainContext> = {}): ExplainContext => ({
  agentId,
  inheritedProviderEnv: [],
  origin: 'renderer',
  ...over,
});
const err = (cliId: string, rawMessage: string, reason: ClassifiedError['reason'] = 'auth_required'): ClassifiedError => ({
  reason,
  rawMessage,
  cliId,
});
const kinds = (e: { actions: readonly { kind: string }[] }): string[] => e.actions.map((a) => a.kind);

describe.each([
  ['pi', 'PI', PI_401],
  ['opencode', 'OpenCode', OPENCODE_401],
])('%s — invalid provider key (PR #35 case)', (cliId, label, raw) => {
  it('no model configured + inherited OPENAI_API_KEY → says the agent picked OpenAI and the inherited key is bad', () => {
    const out = explainError(cliId, err(cliId, raw), ctx(cliId, { inheritedProviderEnv: ['OPENAI_API_KEY'] }));
    expect(out.code).toBe('invalid_provider_key');
    expect(out.params).toMatchObject({ agent: label, provider: 'openai', envVar: 'OPENAI_API_KEY' });
    expect(out.cause).toContain('OPENAI_API_KEY');
    expect(kinds(out)).toEqual(expect.arrayContaining(['pick_model', 'open_settings', 'copy_details']));
  });

  it('no model and no inherited variable → asks to check the provider key, still offers a model', () => {
    const out = explainError(cliId, err(cliId, raw), ctx(cliId));
    expect(out.code).toBe('invalid_provider_key');
    expect(out.params?.['envVar']).toBeUndefined();
    expect(kinds(out)).toContain('pick_model');
  });

  it('a configured model → does not blame a missing model', () => {
    const out = explainError(cliId, err(cliId, raw), ctx(cliId, { configuredModel: 'openai/gpt-5', inheritedProviderEnv: ['OPENAI_API_KEY'] }));
    expect(out.code).toBe('invalid_provider_key');
    expect(out.params?.['model']).toBe('openai/gpt-5');
    expect(kinds(out)).not.toContain('pick_model');
  });

  it('keeps the provider message, with the masked key, in details', () => {
    const out = explainError(cliId, err(cliId, raw), ctx(cliId));
    expect(out.details).toContain('key_vwqb********MBi2');
  });
});

describe('provider failures shared by PI and OpenCode', () => {
  it.each(['pi', 'opencode'])('%s: 429 → rate_limited with retry', (id) => {
    const out = explainError(id, err(id, 'OpenAI API error (429): {"code":"rate_limit_exceeded","message":"Slow down"}', 'rate_limited'), ctx(id));
    expect(out.code).toBe('rate_limited');
    expect(kinds(out)).toContain('retry');
  });

  it.each(['pi', 'opencode'])('%s: insufficient_quota → provider_quota', (id) => {
    const out = explainError(id, err(id, 'OpenAI API error (429): {"code":"insufficient_quota","message":"You exceeded your current quota"}', 'quota_exceeded'), ctx(id));
    expect(out.code).toBe('provider_quota');
    expect(out.params).toMatchObject({ provider: 'openai' });
  });

  it.each(['pi', 'opencode'])('%s: model_not_found → model_unavailable with pick_model', (id) => {
    const out = explainError(id, err(id, 'OpenAI API error (404): {"code":"model_not_found","message":"The model `gpt-x` does not exist"}', 'model_unavailable'), ctx(id, { configuredModel: 'gpt-x' }));
    expect(out.code).toBe('model_unavailable');
    expect(out.params).toMatchObject({ model: 'gpt-x' });
    expect(kinds(out)).toContain('pick_model');
  });

  it.each(['pi', 'opencode'])('%s: 5xx → transient', (id) => {
    expect(explainError(id, err(id, 'Anthropic API error (529): {"message":"Overloaded"}', 'retry'), ctx(id)).code).toBe('transient');
  });

  it('opencode: no provider configured → no_provider with settings', () => {
    const out = explainError('opencode', err('opencode', 'No provider configured'), ctx('opencode'));
    expect(out.code).toBe('no_provider');
    expect(kinds(out)).toContain('open_settings');
  });

  it('opencode: OpenRouter data-policy block → openrouter_policy', () => {
    const out = explainError('opencode', err('opencode', 'No endpoints available matching your data policy', 'model_unavailable'), ctx('opencode'));
    expect(out.code).toBe('openrouter_policy');
  });

  it('opencode: Ollama not running → ollama_down', () => {
    expect(explainError('opencode', err('opencode', 'connect ECONNREFUSED 127.0.0.1:11434 connection refused 11434', 'retry'), ctx('opencode')).code).toBe('ollama_down');
  });

  it('an unrecognised provider message defers to the generic mapping', () => {
    expect(explainError('pi', err('pi', 'something weird', 'unrecoverable'), ctx('pi')).code).toBe('unknown');
  });

  it('Telegram origin: same text, no actions', () => {
    const out = explainError('pi', err('pi', PI_401), ctx('pi', { origin: 'remote' }));
    expect(out.code).toBe('invalid_provider_key');
    expect(out.actions).toEqual([]);
  });
});
