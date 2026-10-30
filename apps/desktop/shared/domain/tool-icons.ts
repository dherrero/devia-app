/**
 * Tool-name icon/label registry (REV-AGENT-CORE-014).
 *
 * Pure data + a thin lookup helper. Lives under `shared/domain/` so it can be
 * imported by the renderer's `ToolCallCardComponent` and unit-tested in the
 * Vitest (Node / src-main) suite without an Angular runtime.
 *
 * Material Symbols icon names — the renderer already ships
 * `@angular/material/icon` so no new dependency is added.
 */

export interface ToolIconEntry {
  /** Material Symbols icon ligature (e.g. `'terminal'`). */
  iconName: string;
  /**
   * Optional human label. When omitted the renderer falls back to the raw
   * tool name (existing behaviour).
   */
  label?: string;
}

/**
 * Canonical map from agent tool name → icon. Keep keys identical to the names
 * the streaming parsers emit so lookups are exact-match.
 *
 * Unknown tools fall through to `getToolIcon(...) === null`; the card component
 * renders today's generic header in that case.
 */
export const TOOL_ICONS: Readonly<Record<string, ToolIconEntry>> = Object.freeze({
  Bash:            { iconName: 'terminal' },
  Edit:            { iconName: 'edit' },
  MultiEdit:       { iconName: 'edit_note' },
  Write:           { iconName: 'save' },
  Read:            { iconName: 'description' },
  Grep:            { iconName: 'search' },
  Glob:            { iconName: 'find_in_page' },
  AskUserQuestion: { iconName: 'help' },
  // Devia's own interface tools. Keyed by their fully-qualified MCP name
  // because that is what the parsers emit. The `devia-ask` entry is the retired
  // S-24 server, kept so transcripts recorded before S-25 still render an icon.
  'mcp__devia-ask__devia_ask_user':      { iconName: 'help' },
  'mcp__devia-ui__devia_ask_user':       { iconName: 'help' },
  'mcp__devia-ui__devia_todo':           { iconName: 'checklist' },
  'mcp__devia-ui__devia_plan_approve':   { iconName: 'fact_check' },
  'mcp__devia-ui__devia_request_review': { iconName: 'rate_review' },
  'mcp__devia-ui__devia_confirm':        { iconName: 'gpp_maybe' },
  'mcp__devia-ui__devia_pick':           { iconName: 'rule_folder' },
  'mcp__devia-ui__devia_notify':         { iconName: 'notifications' },
  'mcp__devia-ui__devia_skill':          { iconName: 'auto_awesome' },
  'mcp__devia-ui__devia_send_file':      { iconName: 'send' },
  'mcp__devia_ui__devia_send_file':      { iconName: 'send' },
  'devia-ui_devia_send_file':            { iconName: 'send' },
  WebSearch:       { iconName: 'travel_explore' },
  WebFetch:        { iconName: 'public' },
  Task:            { iconName: 'assignment' },
  Agent:           { iconName: 'assignment' },
  Execute:         { iconName: 'terminal' },
  NotebookRead:    { iconName: 'description' },
  NotebookEdit:    { iconName: 'edit_note' },
  TodoWrite:       { iconName: 'assignment' },
  Plan:            { iconName: 'assignment' },
  EnterPlanMode:   { iconName: 'assignment' },
  ExitPlanMode:    { iconName: 'assignment' },
});

/**
 * Lookup helper: returns the icon entry for `toolName` or `null` when the name
 * is unknown. Wrap the indexer so callers never receive `undefined` and the
 * Angular template can use the `@if (icon; as i)` idiom directly.
 */
export function getToolIcon(toolName: string): ToolIconEntry | null {
  const entry = TOOL_ICONS[toolName];
  return entry ?? null;
}
