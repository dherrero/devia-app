import { describe, it, expect } from 'vitest';
import { classify } from '../error-classifier';

describe('grok matchers (S-21)', () => {
  it('classifies a missing API key as auth_required with a hint', () => {
    const r = classify('grok', 'Error: API key required. Set GROK_API_KEY env var');
    expect(r.reason).toBe('auth_required');
    expect(r.hint).toMatch(/GROK_API_KEY/);
  });

  it('falls back to the generic table for HTTP 429', () => {
    expect(classify('grok', 'HTTP 429 Too Many Requests').reason).toBe('rate_limited');
  });

  it('classifies generic quota exhaustion', () => {
    expect(classify('grok', 'You have exceeded your current quota').reason).toBe('quota_exceeded');
  });
});
