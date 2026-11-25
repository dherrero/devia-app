import { describe, it, expect } from 'vitest';
import { explainError, type ExplainContext } from './index';
import type { ClassifiedError } from '../../../../../shared/domain/cli-errors';

const ctx = (over: Partial<ExplainContext> = {}): ExplainContext => ({
  agentId: 'some-agent',
  inheritedProviderEnv: [],
  origin: 'renderer',
  ...over,
});
const classified = (over: Partial<ClassifiedError> = {}): ClassifiedError => ({
  reason: 'unrecoverable',
  rawMessage: 'something odd happened',
  cliId: 'some-agent',
  ...over,
});

describe('explainError (generic fallback)', () => {
  it('keeps the raw message as details and always offers copy_details', () => {
    const out = explainError('some-agent', classified(), ctx());
    expect(out.code).toBe('unknown');
    expect(out.details).toBe('something odd happened');
    expect(out.actions.map((a) => a.kind)).toContain('copy_details');
  });

  it('maps auth_required to a login action for the agent', () => {
    const out = explainError('some-agent', classified({ reason: 'auth_required' }), ctx());
    expect(out.code).toBe('auth_required');
    expect(out.actions).toContainEqual({ kind: 'login', agentId: 'some-agent' });
  });

  it('maps model_unavailable to pick_model + settings', () => {
    const out = explainError('some-agent', classified({ reason: 'model_unavailable' }), ctx());
    expect(out.code).toBe('model_unavailable');
    expect(out.actions).toContainEqual({ kind: 'pick_model' });
    expect(out.actions).toContainEqual({ kind: 'open_settings', section: 'execution' });
  });

  it('maps rate_limited and transient errors to retry', () => {
    expect(explainError('a', classified({ reason: 'rate_limited' }), ctx()).actions.map((a) => a.kind)).toContain('retry');
    expect(explainError('a', classified({ reason: 'retry' }), ctx()).code).toBe('transient');
  });

  it('maps compress_context to context_too_large', () => {
    expect(explainError('a', classified({ reason: 'compress_context' }), ctx()).code).toBe('context_too_large');
  });

  it('uses the matcher hint as extra cause text when the matcher supplied one', () => {
    const out = explainError('a', classified({ reason: 'auth_required', hint: 'Run `x login`.' }), ctx());
    expect(out.cause).toContain('Run `x login`.');
  });

  it('redacts secrets in details', () => {
    const out = explainError('a', classified({ rawMessage: 'bad sk-proj-abcdefghijklmnop1234' }), ctx());
    expect(out.details).toBe('bad sk-…[redacted]');
  });

  it('drops UI actions for remote (Telegram) origin, keeping the text', () => {
    const out = explainError('a', classified({ reason: 'auth_required' }), ctx({ origin: 'remote' }));
    expect(out.actions).toEqual([]);
    expect(out.title.length).toBeGreaterThan(0);
  });

  it('never throws on an empty message', () => {
    expect(() => explainError('a', classified({ rawMessage: '' }), ctx())).not.toThrow();
  });
});
