/**
 * REV-TS-CLI-03-02 — User-Supplied Def Can Escalate `envOverrideKeys` Allowlist
 *
 * Unit tests for the `normaliseUserDef` security sanitisation of env-related
 * fields in user-supplied agent definitions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normaliseUserDef } from './index';

describe('normaliseUserDef — envOverrideKeys sanitisation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('filters unsafe keys from envOverrideKeys, retaining only safe *_API_KEY etc keys', () => {
    const result = normaliseUserDef({
      id: 'local-llm',
      bin: 'local-llm',
      envOverrideKeys: ['PATH', 'MY_AGENT_API_KEY', 'HOME', 'GOOD_BASE_URL'],
    });
    expect(result).not.toBeNull();
    expect(result?.envOverrideKeys).toEqual(['MY_AGENT_API_KEY', 'GOOD_BASE_URL']);
  });

  it('strips envOverrideKeys that are not in the safe pattern (PATH, HOME, LD_PRELOAD)', () => {
    const result = normaliseUserDef({
      id: 'local-llm',
      bin: 'local-llm',
      envOverrideKeys: ['PATH', 'HOME', 'LD_PRELOAD'],
    });
    expect(result).not.toBeNull();
    expect(result?.envOverrideKeys).toEqual([]);
  });

  it('accepts all four safe suffix patterns: _API_KEY, _BASE_URL, _CONFIG_DIR, _TOKEN', () => {
    const result = normaliseUserDef({
      id: 'my-agent',
      bin: 'my-agent',
      envOverrideKeys: [
        'MY_API_KEY',
        'MY_BASE_URL',
        'MY_CONFIG_DIR',
        'MY_TOKEN',
      ],
    });
    expect(result).not.toBeNull();
    expect(result?.envOverrideKeys).toHaveLength(4);
  });

  it('logs a warning when unsafe envOverrideKeys are rejected', () => {
    normaliseUserDef({
      id: 'my-agent',
      bin: 'my-agent',
      envOverrideKeys: ['PATH'],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('envOverrideKeys contains unsafe keys'),
    );
  });

  it('produces no envOverrideKeys property when none are provided', () => {
    const result = normaliseUserDef({ id: 'my-agent', bin: 'my-agent' });
    expect(result).not.toBeNull();
    expect(result?.envOverrideKeys).toBeUndefined();
  });
});

describe('normaliseUserDef — env field stripping', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('strips the env field entirely from user-supplied defs', () => {
    const result = normaliseUserDef({
      id: 'my-agent',
      bin: 'my-agent',
      env: { LD_PRELOAD: '/tmp/evil.so', PATH: '/evil/bin' },
    });
    expect(result).not.toBeNull();
    // The `env` property must not appear on the returned def
    expect(Object.prototype.hasOwnProperty.call(result, 'env')).toBe(false);
    expect((result as unknown as Record<string, unknown>)['env']).toBeUndefined();
  });

  it('logs a warning when env field is present and stripped', () => {
    normaliseUserDef({
      id: 'my-agent',
      bin: 'my-agent',
      env: { ANTHROPIC_API_KEY: 'sk-...' },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"env" field is not allowed'),
    );
  });

  it('does not warn or strip when env field is absent', () => {
    normaliseUserDef({ id: 'my-agent', bin: 'my-agent' });
    const envWarning = warnSpy.mock.calls.some((args: unknown[]) =>
      String(args[0]).includes('"env" field is not allowed'),
    );
    expect(envWarning).toBe(false);
  });
});
