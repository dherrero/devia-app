import { describe, expect, it } from 'vitest';
import { getToolDisplayInfo, parseMcpToolName } from './tool-display';
import { getToolIcon } from './tool-icons';

describe('tool display metadata', () => {
  it.each([
    ['Bash', 'terminal', 'tool_card.title.terminal'],
    ['Execute', 'terminal', 'tool_card.title.terminal'],
    ['Read', 'file_read', 'tool_card.title.file_read'],
    ['NotebookRead', 'file_read', 'tool_card.title.file_read'],
    ['Write', 'file_write', 'tool_card.title.file_write'],
    ['Edit', 'file_edit', 'tool_card.title.file_edit'],
    ['MultiEdit', 'file_edit', 'tool_card.title.file_edit'],
    ['Grep', 'local_search', 'tool_card.title.local_search'],
    ['Glob', 'local_search', 'tool_card.title.local_search'],
    ['WebSearch', 'web_search', 'tool_card.title.web_search'],
    ['WebFetch', 'web_search', 'tool_card.title.web_search'],
    ['AskUserQuestion', 'question', 'tool_card.title.question'],
    ['TodoWrite', 'todo', 'tool_card.title.todo'],
    ['Plan', 'plan', 'tool_card.title.plan'],
    ['TaskCreate', 'task_management', 'tool_card.title.task_management'],
    ['Task', 'delegation', 'tool_card.title.delegation'],
    ['SkillLoad', 'skill', 'tool_card.title.skill'],
  ])('maps %s to a semantic title', (name, kind, titleKey) => {
    expect(getToolDisplayInfo(name)).toMatchObject({ kind, titleKey });
  });

  it('extracts MCP server and tool names and exposes the semantic MCP title', () => {
    expect(parseMcpToolName('mcp__github__search_issues')).toEqual({
      serverId: 'github',
      tool: 'search_issues',
    });
    expect(getToolDisplayInfo('mcp__github__search_issues')).toMatchObject({
      kind: 'mcp',
      titleKey: 'tool_card.title.mcp',
      titleParams: { name: 'search_issues' },
    });
  });

  it.each([
    'mcp__devia-ui__devia_send_file',
    'devia-ui_devia_send_file',
    'mcp__devia_ui__devia_send_file',
  ])('recognises %s as a sent file, not a generic MCP call', (name) => {
    expect(getToolDisplayInfo(name)).toEqual({
      kind: 'send_file',
      titleKey: 'tool_card.title.send_file',
      mcpParts: null,
    });
    expect(getToolIcon(name)).toEqual({ iconName: 'send' });
  });

  it('keeps unknown tools readable with a generic translated title', () => {
    expect(getToolDisplayInfo('CustomThing')).toMatchObject({
      kind: 'generic',
      titleKey: 'tool_card.title.generic',
      titleParams: { name: 'CustomThing' },
    });
  });
});
