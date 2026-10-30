import { describe, it, expect } from 'vitest';
import { ConcreteEnvSlicer } from './env-slicer';

describe('ConcreteEnvSlicer', () => {
  it('only includes allowlisted keys from host env', () => {
    const slicer = new ConcreteEnvSlicer({
      baseAllowlist: ['PATH', 'HOME'],
      perProviderOverrides: {},
    });
    const result = slicer.build('any', { PATH: '/usr/bin', HOME: '/root', SECRET: 'topsecret' });
    expect(result['PATH']).toBe('/usr/bin');
    expect(result['HOME']).toBe('/root');
    expect(result['SECRET']).toBeUndefined();
  });

  it('excludes allowlisted keys not present in host env', () => {
    const slicer = new ConcreteEnvSlicer({
      baseAllowlist: ['PATH', 'MISSING_KEY'],
      perProviderOverrides: {},
    });
    const result = slicer.build('any', { PATH: '/usr/bin' });
    expect(Object.keys(result)).toEqual(['PATH']);
  });

  it('merges provider-specific overrides on top of base', () => {
    const slicer = new ConcreteEnvSlicer({
      baseAllowlist: ['PATH'],
      perProviderOverrides: {
        claude: { ANTHROPIC_API_KEY: 'test-key', PATH: '/claude/bin' },
      },
    });
    const result = slicer.build('claude', { PATH: '/usr/bin' });
    // Provider override wins over host env
    expect(result['PATH']).toBe('/claude/bin');
    expect(result['ANTHROPIC_API_KEY']).toBe('test-key');
  });

  it('does not include overrides from other providers', () => {
    const slicer = new ConcreteEnvSlicer({
      baseAllowlist: [],
      perProviderOverrides: {
        provider_a: { ONLY_A: 'val-a' },
        provider_b: { ONLY_B: 'val-b' },
      },
    });
    const result = slicer.build('provider_a', {});
    expect(result['ONLY_A']).toBe('val-a');
    expect(result['ONLY_B']).toBeUndefined();
  });

  it('returns empty object when no keys pass the allowlist', () => {
    const slicer = new ConcreteEnvSlicer({ baseAllowlist: [], perProviderOverrides: {} });
    expect(slicer.build('any', { SECRET: 'x' })).toEqual({});
  });

  it('provider overrides can introduce keys not on allowlist', () => {
    const slicer = new ConcreteEnvSlicer({
      baseAllowlist: [],
      perProviderOverrides: { myagent: { AGENT_KEY: 'abc' } },
    });
    const result = slicer.build('myagent', {});
    expect(result['AGENT_KEY']).toBe('abc');
  });
});
