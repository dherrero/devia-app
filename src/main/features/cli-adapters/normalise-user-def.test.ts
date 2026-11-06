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

describe('normaliseUserDef — ACP agents (S-41)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());

  const acpDef = (acp?: unknown, extra: Record<string, unknown> = {}) => ({
    id: 'my-agent',
    bin: 'my-acp-agent',
    streamFormat: 'acp-json-rpc',
    ...(acp !== undefined && { acp }),
    ...extra,
  });

  it('accepts acp-json-rpc and keeps a sanitised acp block', () => {
    const def = normaliseUserDef(
      acpDef({ args: ['acp', '--flag'], continuity: 'native', planEnforcement: 'agent-mode', modeIds: { plan: 'plan', apply: 'default' } }),
    );
    expect(def?.streamFormat).toBe('acp-json-rpc');
    expect(def?.acp).toEqual({
      args: ['acp', '--flag'],
      continuity: 'native',
      planEnforcement: 'agent-mode',
      modeIds: { plan: 'plan', apply: 'default' },
    });
    expect(def?.buildArgs('p', [], [], {})).toEqual(['acp', '--flag']);
    expect(def?.continuity).toBe('native');
    expect(def?.systemPromptStrategy).toBe('stdin-prepend');
  });

  it('defaults to args ["acp"], continuity replay and planEnforcement none', () => {
    for (const acp of [undefined, {}, { args: undefined }]) {
      const def = normaliseUserDef(acpDef(acp));
      expect(def?.acp).toEqual({ args: ['acp'], continuity: 'replay', planEnforcement: 'none', modeIds: {} });
      expect(def?.buildArgs('p', [], [], {})).toEqual(['acp']);
      expect(def?.continuity).toBe('replay');
    }
  });

  it.each([
    ['not an array', 'acp'],
    ['a number inside', ['acp', 5]],
    ['a newline inside', ['acp\n--evil']],
    ['33 args', Array.from({ length: 33 }, () => 'a')],
    ['an arg of 300 chars', ['a'.repeat(300)]],
  ])('drops the def when args is %s', (_name, args) => {
    expect(normaliseUserDef(acpDef({ args }))).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('accepts exactly 32 args of 256 chars', () => {
    const args = Array.from({ length: 32 }, () => 'a'.repeat(256));
    expect(normaliseUserDef(acpDef({ args }))?.acp?.args).toEqual(args);
  });

  it('falls back to the safe defaults for unknown continuity and planEnforcement values', () => {
    const def = normaliseUserDef(acpDef({ continuity: 'magic', planEnforcement: 'sure' }));
    expect(def?.acp).toMatchObject({ continuity: 'replay', planEnforcement: 'none' });
  });

  it('keeps only valid modeIds entries', () => {
    const def = normaliseUserDef(acpDef({ modeIds: { plan: 'plan', apply: 7, bogus: 'x', 'apply-yolo': 'y'.repeat(65) } }));
    expect(def?.acp?.modeIds).toEqual({ plan: 'plan' });
  });

  it('still rejects a bin with a path or a drive letter even with acp', () => {
    expect(normaliseUserDef(acpDef({}, { bin: '/usr/bin/agent' }))).toBeNull();
    expect(normaliseUserDef(acpDef({}, { bin: 'C:agent' }))).toBeNull();
    expect(normaliseUserDef(acpDef({}, { bin: '..\\agent' }))).toBeNull();
  });

  it('still strips env and filters envOverrideKeys', () => {
    const def = normaliseUserDef(acpDef({}, { env: { PATH: '/evil' }, envOverrideKeys: ['PATH', 'AGENT_API_KEY'] }));
    expect(def?.env).toBeUndefined();
    expect(def?.envOverrideKeys).toEqual(['AGENT_API_KEY']);
  });

  it('ignores unknown acp keys', () => {
    const def = normaliseUserDef(acpDef({ args: ['acp'], command: 'rm -rf /', env: { A: 'b' }, clientCapabilities: { terminal: true } }));
    expect(Object.keys(def?.acp ?? {}).sort()).toEqual(['args', 'continuity', 'modeIds', 'planEnforcement']);
  });

  it('drops an acp block on a def that is not acp-json-rpc', () => {
    const def = normaliseUserDef({ id: 'x', bin: 'x', streamFormat: 'plain', acp: { args: ['acp'] } });
    expect(def?.acp).toBeUndefined();
    expect(def?.streamFormat).toBe('plain');
  });

  it('a user def keeps explicit control of nothing it should not: no env and prompt strategy stays stdin-prepend', () => {
    const def = normaliseUserDef(acpDef({}, { systemPromptStrategy: 'argv' }));
    expect(def?.systemPromptStrategy).toBe('stdin-prepend');
  });

  it('a PATH name that merely looks like a launcher (npx, uvx) follows the same bin rules', () => {
    // npx/uvx run remote code under the user's own responsibility: they are plain PATH names.
    expect(normaliseUserDef(acpDef({ args: ['@scope/agent', 'acp'] }, { bin: 'npx' }))?.bin).toBe('npx');
    expect(normaliseUserDef(acpDef({}, { bin: './npx' }))).toBeNull();
  });
});

describe('user ACP defs cannot take over a built-in id (S-41)', () => {
  it.each(['claude', 'pi', 'opencode', 'kimi', 'hermes'])('registerAdditional rejects a user def with the id %s', async (id) => {
    const { StaticCliAdapterRegistry } = await import('./infrastructure/registry');
    const registry = new StaticCliAdapterRegistry();
    const builtIn = registry.get(id);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const user = normaliseUserDef({ id, bin: 'evil', streamFormat: 'acp-json-rpc', acp: { args: ['x'] } });
    registry.registerAdditional(user ? [user] : []);
    spy.mockRestore();
    expect(registry.get(id)).toBe(builtIn);
    expect(registry.get(id)?.bin).not.toBe('evil');
  });
});
