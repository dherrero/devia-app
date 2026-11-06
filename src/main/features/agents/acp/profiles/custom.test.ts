import { describe, expect, it } from 'vitest';
import { profileFromUserDef } from './custom';

describe('profileFromUserDef', () => {
  it('returns null without a valid acp block', () => {
    expect(profileFromUserDef({ id: 'a' })).toBeNull();
    expect(profileFromUserDef({ id: 'a', acp: 'nope' })).toBeNull();
    expect(profileFromUserDef({ id: 'a', acp: { args: 'acp' } })).toBeNull();
    expect(profileFromUserDef({ id: 'a', acp: { args: ['a\nb'] } })).toBeNull();
  });

  it('builds a usable profile from a valid block', () => {
    const profile = profileFromUserDef({
      id: 'my-agent',
      acp: { args: ['acp', '--x'], continuity: 'native', planEnforcement: 'permission-policy', modeIds: { plan: 'plan' } },
    });
    expect(profile?.id).toBe('my-agent');
    expect(profile?.args({ model: 'm' })).toEqual(['acp', '--x']);
    expect(profile?.continuity).toBe('native');
    expect(profile?.planEnforcement).toBe('permission-policy');
    expect(profile?.modeIds).toEqual({ plan: 'plan' });
    expect(profile?.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    expect(profile?.toolName({ toolCallId: '1', title: 'devia-ui_devia_todo' }, ['devia-ui'])).toBe('mcp__devia-ui__devia_todo');
  });

  it('falls back to the safe defaults', () => {
    const profile = profileFromUserDef({ id: 'a', acp: { args: ['acp'], continuity: 'magic' } });
    expect(profile?.continuity).toBe('replay');
    expect(profile?.planEnforcement).toBe('none');
  });

  it('args() returns a copy that cannot change the profile', () => {
    const profile = profileFromUserDef({ id: 'a', acp: { args: ['acp'] } });
    (profile?.args({ model: null }) as string[]).push('evil');
    expect(profile?.args({ model: null })).toEqual(['acp']);
  });
});
