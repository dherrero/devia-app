import { describe, it, expect } from 'vitest';
import { explainError, type ExplainContext } from './index';
import type { ClassifiedError } from '../../../../../shared/domain/cli-errors';

// No recorded logs exist for these agents: strings come from their matcher tables / ACP conventions (unverified live).
const ctx = (agentId: string, over: Partial<ExplainContext> = {}): ExplainContext => ({ agentId, inheritedProviderEnv: [], origin: 'renderer', ...over });
const err = (cliId: string, rawMessage: string, reason: ClassifiedError['reason'] = 'unrecoverable'): ClassifiedError => ({ reason, rawMessage, cliId });

describe.each([
  ['qwen', 'Set DASHSCOPE_API_KEY', 'auth_required'],
  ['qwen', '账户余额不足', 'provider_quota'],
  ['qwen', 'Throttling.User: slow down', 'rate_limited'],
  ['qwen', '超过最大长度', 'context_too_large'],
  ['deepseek', 'DeepSeek invalid key', 'auth_required'],
  ['deepseek', 'deepseek insufficient balance', 'provider_quota'],
  ['deepseek', 'deepseek-chat is not available', 'model_unavailable'],
  ['qoder', 'Qoder login required', 'auth_required'],
  ['qoder', 'Qoder quota exhausted', 'provider_quota'],
  ['grok', 'GROK_API_KEY missing', 'auth_required'],
  ['kimi', 'Authentication required', 'auth_required'],
  ['hermes', 'JSON-RPC error -32000', 'auth_required'],
  ['kimi', 'spawn kimi ENOENT', 'not_installed'],
])('%s: %s', (cliId, raw, code) => {
  it(`→ ${code}`, () => {
    expect(explainError(cliId, err(cliId, raw), ctx(cliId)).code).toBe(code);
  });
});

describe('API-backed agents also get the provider reading', () => {
  it.each(['qwen', 'deepseek', 'grok', 'kimi', 'hermes'])('%s: 429 → rate_limited', (id) => {
    expect(explainError(id, err(id, 'OpenAI API error (429): {"code":"rate_limit_exceeded"}', 'rate_limited'), ctx(id)).code).toBe('rate_limited');
  });
});

describe('every agent', () => {
  it.each(['qwen', 'deepseek', 'qoder', 'grok', 'kimi', 'hermes'])('%s: unknown text → generic, raw kept in details', (id) => {
    const out = explainError(id, err(id, 'odd failure'), ctx(id));
    expect(out.code).toBe('unknown');
    expect(out.details).toBe('odd failure');
  });
  it('Telegram origin drops actions', () => {
    expect(explainError('qoder', err('qoder', 'Qoder login required'), ctx('qoder', { origin: 'remote' })).actions).toEqual([]);
  });
});
