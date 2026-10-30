import { describe, it, expect } from 'vitest';
import { mapErrorToUi, validateRecoveryHint, isTrustedRecoveryHint } from './error-ui-mapper';
import type { ChatError } from '../../../../shared/domain/chat-error';
import type { ChatErrorCode } from '../../../../shared/domain/chat-error';

function err(code: ChatError['code'], hint?: string): ChatError {
  return { code, message: 'test', recoverable: false, retryable: false, ...(hint !== undefined ? { recoveryHint: hint } : {}) };
}

const ALL_CODES: ChatErrorCode[] = [
  'BAD_REQUEST', 'PROVIDER_UNKNOWN', 'PROVIDER_UNAVAILABLE', 'AUTH_REQUIRED',
  'PROMPT_TOO_LARGE', 'SPAWN_FAILED', 'INACTIVITY_TIMEOUT', 'PARSER_DESYNC',
  'EMPTY_OUTPUT', 'STORE_CONFLICT', 'RATE_LIMITED', 'UPSTREAM_UNAVAILABLE',
  'CANCELED', 'INTERNAL',
];

describe('mapErrorToUi', () => {
  it('returns a non-empty message for every code in the catalogue', () => {
    for (const code of ALL_CODES) {
      const copy = mapErrorToUi(err(code));
      expect(copy.message.length).toBeGreaterThan(0);
    }
  });

  it('returns a message for unknown code', () => {
    const copy = mapErrorToUi(err('UNKNOWN_FUTURE_CODE'));
    expect(copy.message).toBeTruthy();
  });

  it('AUTH_REQUIRED copy includes action', () => {
    const copy = mapErrorToUi(err('AUTH_REQUIRED'));
    expect(copy.action).toBeTruthy();
  });

  it('INTERNAL copy includes action for diagnostic', () => {
    const copy = mapErrorToUi(err('INTERNAL'));
    expect(copy.action).toBeTruthy();
  });
});

// AC6: recoveryHint URL validation
describe('validateRecoveryHint (AC6)', () => {
  it('allows trusted Anthropic URL', () => {
    expect(validateRecoveryHint('https://www.anthropic.com/docs')).toBeTruthy();
  });

  it('allows in-app devia:// deep links', () => {
    expect(validateRecoveryHint('devia://settings/agents/claude')).toBeTruthy();
  });

  it('rejects untrusted URL — phishing prevention (AC6)', () => {
    expect(validateRecoveryHint('https://evil.com/steal-credentials')).toBeUndefined();
  });

  it('rejects http non-trusted host', () => {
    expect(validateRecoveryHint('http://random-host.io/page')).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(validateRecoveryHint(undefined)).toBeUndefined();
  });
});

describe('isTrustedRecoveryHint', () => {
  it('allows OpenAI', () => expect(isTrustedRecoveryHint('https://openai.com/')).toBe(true));
  it('allows Google', () => expect(isTrustedRecoveryHint('https://google.com/')).toBe(true));
  it('rejects unknown host', () => expect(isTrustedRecoveryHint('https://notallowed.com/')).toBe(false));
});
