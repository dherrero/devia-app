import { describe, expect, it } from 'vitest';
import { isSecretKey, maskSecretValue, redactEnvForLog } from './secret-redact';

describe('secret-redact', () => {
  it('flags secret-looking keys', () => {
    expect(isSecretKey('ANTHROPIC_API_KEY')).toBe(true);
    expect(isSecretKey('MI_SECRETO')).toBe(true);
    expect(isSecretKey('GITHUB_TOKEN')).toBe(true);
    expect(isSecretKey('AWS_SECRET_ACCESS_KEY')).toBe(true);
    expect(isSecretKey('ANTHROPIC_BASE_URL')).toBe(false);
    expect(isSecretKey('CLAUDE_CONFIG_DIR')).toBe(false);
  });

  it('masks all but the last 2 chars (capped run)', () => {
    expect(maskSecretValue('hola-soy-un-secreto')).toBe('************to');
    expect(maskSecretValue('sk-12345')).toBe('******45');
    expect(maskSecretValue('ab')).toBe('**');
    expect(maskSecretValue('a')).toBe('*');
  });

  it('redacts only secret-keyed values in an env dump', () => {
    const out = redactEnvForLog({
      ANTHROPIC_BASE_URL: 'http://localhost:1234',
      ANTHROPIC_API_KEY: 'sk-ant-superlongsecret',
    });
    expect(out).toContain('ANTHROPIC_BASE_URL=http://localhost:1234');
    expect(out).toContain('ANTHROPIC_API_KEY=');
    expect(out).not.toContain('sk-ant-superlongsecret');
  });

  it('returns (none) for an empty env', () => {
    expect(redactEnvForLog({})).toBe('(none)');
  });
});
