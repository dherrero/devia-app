export type ToolDisplayKind =
  | 'terminal'
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'local_search'
  | 'web_search'
  | 'question'
  | 'todo'
  | 'plan'
  | 'task_management'
  | 'delegation'
  | 'skill'
  | 'send_file'
  | 'mcp'
  | 'generic';

export interface McpToolParts {
  readonly serverId: string;
  readonly tool: string;
}

export interface ToolDisplayInfo {
  readonly kind: ToolDisplayKind;
  readonly titleKey: string;
  readonly titleParams?: Readonly<Record<string, string>>;
  readonly mcpParts: McpToolParts | null;
}

const TOOL_KIND_BY_NAME: Readonly<Record<string, ToolDisplayKind>> = Object.freeze({
  Read: 'file_read',
  NotebookRead: 'file_read',
  Write: 'file_write',
  Edit: 'file_edit',
  MultiEdit: 'file_edit',
  NotebookEdit: 'file_edit',
  file_change: 'file_edit',
  Bash: 'terminal',
  Execute: 'terminal',
  Grep: 'local_search',
  Glob: 'local_search',
  WebFetch: 'web_search',
  WebSearch: 'web_search',
  AskUserQuestion: 'question',
  TodoWrite: 'todo',
  Plan: 'plan',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan',
  TaskCreate: 'task_management',
  TaskUpdate: 'task_management',
  TaskList: 'task_management',
  TaskGet: 'task_management',
  TaskStop: 'task_management',
  TaskOutput: 'task_management',
  Task: 'delegation',
  Agent: 'delegation',
});

/**
 * Every name `devia_send_file` (S-32) reaches the transcript under: the
 * canonical MCP form (Claude, and pi once its mapper restores the server id),
 * OpenCode's `<server>_<tool>` and pi's sanitised `devia_ui` form, which an
 * un-normalised transcript can still carry. Checked before the generic MCP
 * branch so the card reads as "file sent", not as an anonymous MCP call.
 */
export const SEND_FILE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'mcp__devia-ui__devia_send_file',
  'devia-ui_devia_send_file',
  'mcp__devia_ui__devia_send_file',
]);

export function isSendFileTool(name: string | undefined): boolean {
  return name !== undefined && SEND_FILE_TOOL_NAMES.has(name);
}

export function parseMcpToolName(name: string): McpToolParts | null {
  const match = /^mcp__([^_]+)__(.+)$/.exec(name);
  if (!match?.[1] || !match[2]) return null;
  return { serverId: match[1], tool: match[2] };
}

export function getToolDisplayInfo(name: string): ToolDisplayInfo {
  if (isSendFileTool(name)) {
    return { kind: 'send_file', titleKey: 'tool_card.title.send_file', mcpParts: null };
  }

  const mcpParts = parseMcpToolName(name);
  if (mcpParts) {
    return {
      kind: 'mcp',
      titleKey: 'tool_card.title.mcp',
      titleParams: { name: mcpParts.tool },
      mcpParts,
    };
  }

  if (name.startsWith('Skill')) {
    return { kind: 'skill', titleKey: 'tool_card.title.skill', mcpParts: null };
  }

  const kind = TOOL_KIND_BY_NAME[name] ?? 'generic';
  const titleKey = `tool_card.title.${kind}`;
  return kind === 'generic'
    ? { kind, titleKey, titleParams: { name }, mcpParts: null }
    : { kind, titleKey, mcpParts: null };
}
