import { describe, expect, it } from 'vitest';
import { buildRemoteShellEnv } from './shell-runner';

describe('buildRemoteShellEnv', () => {
  it('keeps only shell bootstrap variables and drops secrets', () => {
    const env = buildRemoteShellEnv({
      PATH: '/usr/bin',
      HOME: '/home/devia',
      API_KEY: 'secret',
      GITHUB_TOKEN: 'gh_secret',
      INTERNAL_JWT_PRIVATE_KEY: 'private',
    });

    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/devia');
    expect(env['API_KEY']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['INTERNAL_JWT_PRIVATE_KEY']).toBeUndefined();
  });
});
