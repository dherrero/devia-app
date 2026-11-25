import { describe, it, expect } from 'vitest';
import { explainError, type ExplainContext } from './index';
import type { ClassifiedError } from '../../../../../shared/domain/cli-errors';

const ctx = (over: Partial<ExplainContext> = {}): ExplainContext => ({
  agentId: 'claude',
  inheritedProviderEnv: [],
  origin: 'renderer',
  ...over,
});
const err = (rawMessage: string, reason: ClassifiedError['reason'] = 'unrecoverable'): ClassifiedError => ({
  reason,
  rawMessage,
  cliId: 'claude',
});
const kinds = (e: { actions: readonly { kind: string }[] }): string[] => e.actions.map((a) => a.kind);

const RESETS_AT = new Date(2030, 0, 15, 11, 30, 0).getTime();

describe('Claude explainer — usage limit', () => {
  it('says when it resumes when auto-continue is on, and offers no switch', () => {
    const out = explainError('claude', err("You've hit your session limit · resets 11:30am (Europe/Madrid)"), ctx({ resetsAt: RESETS_AT, autoContinueEnabled: true }));
    expect(out.code).toBe('usage_limit');
    expect(out.params).toMatchObject({ resetsAt: RESETS_AT });
    expect(String(out.params?.['time'])).toMatch(/\d{1,2}:\d{2}/);
    expect(out.cause).toContain(String(out.params?.['time']));
    expect(kinds(out)).not.toContain('enable_auto_continue');
    expect(out.variant).toBe('auto');
  });

  it('offers to turn auto-continue on when it is off', () => {
    const out = explainError('claude', err("You've hit your session limit"), ctx({ resetsAt: RESETS_AT, autoContinueEnabled: false }));
    expect(out.code).toBe('usage_limit');
    expect(out.actions).toContainEqual({ kind: 'enable_auto_continue', agentId: 'claude' });
    expect(out.variant).toBe('manual');
  });

  it('works without resetsAt: no time, still explains the limit', () => {
    const out = explainError('claude', err('Claude usage limit reached'), ctx());
    expect(out.code).toBe('usage_limit');
    expect(out.params?.['time']).toBeUndefined();
    expect(out.variant).toBe('notime');
  });

  it('recognises the limit from resetsAt alone when the text is unhelpful', () => {
    const out = explainError('claude', err('process exited with code 1'), ctx({ resetsAt: RESETS_AT, autoContinueEnabled: true }));
    expect(out.code).toBe('usage_limit');
  });

  it('keeps the raw text in details', () => {
    const raw = "You've hit your session limit · resets 11:30am (Europe/Madrid)";
    expect(explainError('claude', err(raw), ctx()).details).toBe(raw);
  });

  it('gives a Telegram run the text with no actions', () => {
    const out = explainError('claude', err("You've hit your session limit"), ctx({ resetsAt: RESETS_AT, origin: 'remote' }));
    expect(out.code).toBe('usage_limit');
    expect(out.actions).toEqual([]);
  });
});

describe('Claude explainer — other failures', () => {
  it('not logged in → login action', () => {
    const out = explainError('claude', err('Not logged in · Please run /login', 'auth_required'), ctx());
    expect(out.code).toBe('auth_required');
    expect(out.actions).toContainEqual({ kind: 'login', agentId: 'claude' });
  });

  it('image over 5 MB → context_too_large with an image-specific cause', () => {
    const out = explainError('claude', err('image exceeds 5 MB maximum', 'compress_context'), ctx());
    expect(out.code).toBe('image_too_large');
  });

  it('prompt too long → context_too_large', () => {
    expect(explainError('claude', err('Prompt is too long', 'compress_context'), ctx()).code).toBe('context_too_large');
  });

  it('overloaded API → transient with retry', () => {
    const out = explainError('claude', err('Anthropic API error 529 overloaded_error', 'retry'), ctx());
    expect(out.code).toBe('transient');
    expect(kinds(out)).toContain('retry');
  });

  it('enterprise-managed MCP config → its own explanation', () => {
    const out = explainError('claude', err('--strict-mcp-config cannot be used: enterprise MCP config is present'), ctx());
    expect(out.code).toBe('enterprise_mcp');
  });

  it('an unrelated error defers to the generic mapping', () => {
    expect(explainError('claude', err('weird crash'), ctx()).code).toBe('unknown');
  });
});
