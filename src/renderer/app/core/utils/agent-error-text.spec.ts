import { describe, it, expect } from 'vitest';
import { agentErrorText } from './agent-error-text';
import type { UserFacingError } from '../../../../shared/domain/user-facing-error';

const err = (over: Partial<UserFacingError> = {}): UserFacingError => ({
  code: 'usage_limit',
  title: 'fallback title',
  cause: 'fallback cause',
  actions: [],
  details: '',
  ...over,
});
const translator = (dict: Record<string, string>) => ({
  instant: (key: string, params?: object): string => {
    const raw = dict[key];
    if (raw === undefined) return key;
    return raw.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String((params as Record<string, unknown> | undefined)?.[k] ?? ''));
  },
});

describe('agentErrorText', () => {
  it('uses the translated title and the variant cause with params', () => {
    const t = translator({
      'agent_error.usage_limit.title': 'Limit reached',
      'agent_error.usage_limit.cause_auto': 'Resumes at {{time}}',
      'agent_error.usage_limit.cause': 'generic',
    });
    expect(agentErrorText(t, err({ variant: 'auto', params: { time: '11:30' } }))).toEqual({ title: 'Limit reached', cause: 'Resumes at 11:30' });
  });

  it('falls back to the plain cause key when the variant has none', () => {
    const t = translator({ 'agent_error.usage_limit.title': 'T', 'agent_error.usage_limit.cause': 'plain' });
    expect(agentErrorText(t, err({ variant: 'zzz' })).cause).toBe('plain');
  });

  it('falls back to the main-side text for a code with no keys', () => {
    expect(agentErrorText(translator({}), err({ code: 'brand_new' }))).toEqual({ title: 'fallback title', cause: 'fallback cause' });
  });
});
