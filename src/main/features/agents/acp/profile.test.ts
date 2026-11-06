import { describe, expect, it } from 'vitest';
import { ACP_PROFILES, defaultToolName, profileFor } from './profile';

const IDS = ['devia-ui', 'devia-kanban'];

describe('ACP profiles', () => {
  it('registers kimi and hermes only', () => {
    expect(Object.keys(ACP_PROFILES).sort()).toEqual(['hermes', 'kimi']);
    expect(profileFor('kimi')?.id).toBe('kimi');
    expect(profileFor('hermes')?.id).toBe('hermes');
    for (const id of ['claude', 'pi', 'opencode', 'x', 'toString']) expect(profileFor(id)).toBeUndefined();
  });

  it('builds the launch args of each agent', () => {
    expect(profileFor('kimi')?.args({ model: null })).toEqual(['acp']);
    expect(profileFor('hermes')?.args({ model: null })).toEqual(['acp', '--accept-hooks']);
  });

  it('declares no fs or terminal client capabilities and safe defaults', () => {
    for (const id of ['kimi', 'hermes']) {
      const p = profileFor(id);
      expect(p?.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
      expect(p?.continuity).toBe('replay');
      expect(p?.planEnforcement).toBe('none');
    }
  });
});

describe('defaultToolName', () => {
  const name = (call: Parameters<typeof defaultToolName>[0]): string => defaultToolName(call, IDS);

  it('keeps a canonical MCP name untouched', () => {
    expect(name({ toolCallId: '1', title: 'mcp__devia-ui__devia_todo' })).toBe('mcp__devia-ui__devia_todo');
  });

  it('canonicalises <id>_<tool>, <id>.<tool> and <id>/<tool>', () => {
    expect(name({ toolCallId: '1', title: 'devia-ui_devia_todo' })).toBe('mcp__devia-ui__devia_todo');
    expect(name({ toolCallId: '1', title: 'devia-kanban.kanban_list' })).toBe('mcp__devia-kanban__kanban_list');
    expect(name({ toolCallId: '1', title: 'devia-ui/devia_notify' })).toBe('mcp__devia-ui__devia_notify');
  });

  it('prefers the longest matching server id', () => {
    expect(defaultToolName({ toolCallId: '1', title: 'devia-ui-extra_run' }, ['devia-ui', 'devia-ui-extra'])).toBe(
      'mcp__devia-ui-extra__run',
    );
  });

  it('reads the name from rawInput when the title is generic', () => {
    expect(name({ toolCallId: '1', title: 'Run tool', rawInput: { name: 'devia-ui_devia_todo' } })).toBe(
      'mcp__devia-ui__devia_todo',
    );
  });

  it('keeps a built-in title, falls back to kind and then to tool', () => {
    expect(name({ toolCallId: '1', title: 'Read file' })).toBe('Read file');
    expect(name({ toolCallId: '1', kind: 'edit' })).toBe('edit');
    expect(name({ toolCallId: '1' })).toBe('tool');
  });
});

describe('hermes tool names (verified against Hermes 0.23.0)', () => {
  const name = (title: string, ids = ['devia-ui', 'devia-kanban', 'devia-memory', 'e2e-echo']): string | undefined =>
    profileFor('hermes')?.toolName({ toolCallId: '1', title }, ids);

  it('restores the real server id from the editor-prefixed, hashed form', () => {
    expect(name('mcp__editor_devia_ui_9f57544a__devia_todo')).toBe('mcp__devia-ui__devia_todo');
    expect(name('mcp__editor_devia_kanban_abd708d6__kanban_create_spec')).toBe('mcp__devia-kanban__kanban_create_spec');
    expect(name('mcp__editor_e2e_echo_0a1b2c3d__echo_token')).toBe('mcp__e2e-echo__echo_token');
  });

  it('restores it from rawInput when the title is a display string', () => {
    expect(
      profileFromRaw({ title: 'Editor Devia Kanban Bc770865 · kanban list', rawInput: { name: 'mcp__editor_devia_kanban_bc770865__kanban_list' } }),
    ).toBe('mcp__devia-kanban__kanban_list');
  });

  it('drops a title suffix that is an argument, not part of the tool name', () => {
    expect(name('mcp__editor_devia_ui_9f57544a__devia_skill: e2e-reviewer')).toBe('mcp__devia-ui__devia_skill');
  });

  it('leaves built-in Hermes tools and unknown servers alone', () => {
    expect(name('terminal: echo "hola"')).toBe('terminal: echo "hola"');
    expect(name('mcp__editor_other_srv_12345678__run')).toBe('mcp__editor_other_srv_12345678__run');
  });

  it('still understands the plain forms', () => {
    expect(name('mcp__devia-ui__devia_todo')).toBe('mcp__devia-ui__devia_todo');
  });
});

function profileFromRaw(call: { title: string; rawInput: unknown }): string | undefined {
  return profileFor('hermes')?.toolName({ toolCallId: '1', ...call }, ['devia-ui', 'devia-kanban']);
}
