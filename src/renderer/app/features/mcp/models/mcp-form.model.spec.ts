import { describe, expect, it } from 'vitest';

import { envToText, formFromConfig, joinArgs, parseEnv, splitArgs } from './mcp-form.model';

describe('splitArgs', () => {
  it('splits on whitespace, as before', () => {
    expect(splitArgs('-y @x/tiendas  --flag')).toEqual(['-y', '@x/tiendas', '--flag']);
    expect(splitArgs('   ')).toEqual([]);
    expect(splitArgs('')).toEqual([]);
  });

  it('keeps a double-quoted argument together, spaces included', () => {
    expect(splitArgs('--path "/Users/me/My Projects/x.cjs" --v')).toEqual(['--path', '/Users/me/My Projects/x.cjs', '--v']);
  });
});

describe('joinArgs', () => {
  it('quotes only the arguments that need it', () => {
    expect(joinArgs(['-y', '/a b/c.cjs'])).toBe('-y "/a b/c.cjs"');
  });

  it('round-trips through splitArgs, so editing never changes an argument', () => {
    for (const args of [[], ['a'], ['-y', '@x/y'], ['/Users/me/My Projects/x.cjs', '--flag', 'two words']]) {
      expect(splitArgs(joinArgs(args))).toEqual(args);
    }
  });
});

describe('envToText', () => {
  it('writes KEY=VALUE lines and round-trips through parseEnv', () => {
    const env = { STORES_ROLE: 'ventas', API_URL: 'https://x.test/a?b=c' };
    expect(parseEnv(envToText(env))).toEqual(env);
  });

  it('is empty when there is no env', () => {
    expect(envToText(undefined)).toBe('');
    expect(envToText({})).toBe('');
  });
});

describe('formFromConfig', () => {
  const config = {
    id: '1', name: 'tiendas', description: 'Demo', command: 'node', args: ['/p with space/x.cjs'],
    env: { STORES_ROLE: 'tiendas' }, allowedEnvKeys: ['EXTRA'], agents: ['claude'] as const,
    scope: 'global' as const, source: 'manual' as const, enabled: true, exposure: 'codemode' as const,
  };

  it('fills every field of the form from the stored server', () => {
    const f = formFromConfig({ ...config, agents: ['claude'] });
    expect(f).toMatchObject({
      id: '1', name: 'tiendas', description: 'Demo', command: 'node',
      argsText: '"/p with space/x.cjs"', envText: 'STORES_ROLE=tiendas', scope: 'global', source: 'manual',
    });
    expect([...f.agents]).toEqual(['claude']);
  });

  it('carries what the form does not show, so saving does not lose it', () => {
    const f = formFromConfig({ ...config, agents: ['claude'] });
    expect(f.allowedEnvKeys).toEqual(['EXTRA']);
    expect(f.enabled).toBe(true);
  });

  it('handles a server with no description and no env', () => {
    const f = formFromConfig({ id: 'a', name: 'a', command: 'x', args: [], agents: ['claude'], scope: 'project', source: 'npm', enabled: false });
    expect(f).toMatchObject({ description: '', envText: '', argsText: '', scope: 'project', enabled: false });
  });
});
