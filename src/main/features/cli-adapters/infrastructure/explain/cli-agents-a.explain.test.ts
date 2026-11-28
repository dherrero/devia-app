import { describe, it, expect } from 'vitest';
import { explainError, type ExplainContext } from './index';
import type { ClassifiedError } from '../../../../../shared/domain/cli-errors';

// No recorded logs exist for these agents: the strings come from their matcher tables (unverified live).
const ctx = (agentId: string, over: Partial<ExplainContext> = {}): ExplainContext => ({ agentId, inheritedProviderEnv: [], origin: 'renderer', ...over });
const err = (cliId: string, rawMessage: string, reason: ClassifiedError['reason'] = 'unrecoverable'): ClassifiedError => ({ reason, rawMessage, cliId });
const kinds = (e: { actions: readonly { kind: string }[] }): string[] => e.actions.map((a) => a.kind);

describe('Codex', () => {
  it('MCP cancelled under the managed sandbox → codex_mcp_sandbox', () => {
    expect(explainError('codex', err('codex', 'user cancelled MCP tool call'), ctx('codex')).code).toBe('codex_mcp_sandbox');
  });
  it('missing key / login → auth with login action', () => {
    const out = explainError('codex', err('codex', 'Set your OPENAI_API_KEY', 'auth_required'), ctx('codex'));
    expect(out.code).toBe('auth_required');
    expect(out.actions).toContainEqual({ kind: 'login', agentId: 'codex' });
  });
  it('reconnecting → transient', () => {
    expect(explainError('codex', err('codex', 'Reconnecting... 2/5', 'retry'), ctx('codex')).code).toBe('transient');
  });
  it('falls back to the provider reading (quota)', () => {
    expect(explainError('codex', err('codex', 'insufficient_quota: You exceeded your current quota', 'quota_exceeded'), ctx('codex')).code).toBe('provider_quota');
  });
});

describe('Gemini', () => {
  it.each([
    ['UNAUTHENTICATED: request had invalid credentials', 'auth_required'],
    ['PERMISSION_DENIED: API key not valid', 'auth_required'],
    ['Quota exceeded for metric generate_content', 'provider_quota'],
    ['RESOURCE_EXHAUSTED: 429', 'rate_limited'],
    ['The token count exceeds the maximum', 'context_too_large'],
    ['UNAVAILABLE: model is overloaded', 'transient'],
  ])('%s → %s', (raw, code) => {
    expect(explainError('gemini', err('gemini', raw), ctx('gemini')).code).toBe(code);
  });
});

describe('Cursor and Copilot', () => {
  it('Cursor not logged in → login action', () => {
    const out = explainError('cursor-agent', err('cursor-agent', 'Not logged in. Run cursor-agent login'), ctx('cursor-agent'));
    expect(out.code).toBe('auth_required');
    expect(kinds(out)).toContain('login');
  });
  it('Cursor usage limit → provider_quota', () => {
    expect(explainError('cursor-agent', err('cursor-agent', 'Cursor usage limit reached'), ctx('cursor-agent')).code).toBe('provider_quota');
  });
  it('Copilot gh auth → login action', () => {
    expect(explainError('copilot', err('copilot', 'Run gh auth login first'), ctx('copilot')).actions).toContainEqual({ kind: 'login', agentId: 'copilot' });
  });
  it('Copilot subscription required → copilot_access', () => {
    expect(explainError('copilot', err('copilot', 'Copilot subscription required'), ctx('copilot')).code).toBe('copilot_access');
  });
  it('unknown text defers to generic for all four', () => {
    for (const id of ['codex', 'gemini', 'cursor-agent', 'copilot']) {
      expect(explainError(id, err(id, 'odd failure'), ctx(id)).code).toBe('unknown');
    }
  });
  it('Telegram origin drops actions but keeps the code', () => {
    const out = explainError('gemini', err('gemini', 'UNAUTHENTICATED'), ctx('gemini', { origin: 'remote' }));
    expect(out.code).toBe('auth_required');
    expect(out.actions).toEqual([]);
  });
});
