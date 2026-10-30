/**
 * Derives a short, contextual status summary for a tool call so the bubble can
 * render a status pill ("142 líneas", "aplicando…", "3 cambios") instead of a
 * bare check mark (audit v2 · 05-tool-call-cards · TC-02).
 *
 * Lives under `shared/domain/` so it can be imported by the renderer's
 * `ToolCallCardComponent` and unit-tested in the Vitest (Node) suite without an
 * Angular runtime. Returns an i18n key + params rather than a finished string —
 * the component translates it so the copy stays localised.
 *
 * The function is deliberately tolerant of the different shapes each agent
 * produces: Claude sends rich inputs (`{ file_path }`, `{ command }`, …) while
 * Codex/Gemini/OpenCode normalise file edits to `{ changes: [...] }` and only
 * ever emit `Bash` + `Edit`. Anything unrecognised falls back to a generic
 * "done" so no agent ever produces an empty pill.
 */

import type { ToolCallRecord } from './chat';

export type ToolSummaryState = 'running' | 'success' | 'error';

export interface ToolSummary {
  state: ToolSummaryState;
  /** i18n key under `tool_summary.*`. */
  key: string;
  /** Interpolation params for the key (only `count` today). */
  params?: { count: number };
}

const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'file_change']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const EXEC_TOOLS = new Set(['Bash', 'Execute']);

function countLines(text: string): number {
  const trimmed = text.replace(/\n+$/, '');
  if (!trimmed) return 0;
  return trimmed.split('\n').length;
}

/** Number of edits in a `{ changes: [...] }` input, or null when absent. */
function changeCount(input: unknown): number | null {
  if (input !== null && typeof input === 'object') {
    const changes = (input as Record<string, unknown>)['changes'];
    if (Array.isArray(changes)) return changes.length;
  }
  return null;
}

export function summarizeToolCall(tc: ToolCallRecord): ToolSummary {
  const name = tc.name;
  // `result === undefined` (not falsy) so a successful tool with empty output
  // is treated as done, never stuck in the running state.
  const running = tc.result === undefined && !tc.isError;

  if (running) {
    if (READ_TOOLS.has(name)) return { state: 'running', key: 'tool_summary.reading' };
    if (EDIT_TOOLS.has(name) || name === 'Write') return { state: 'running', key: 'tool_summary.applying' };
    if (EXEC_TOOLS.has(name)) return { state: 'running', key: 'tool_summary.executing' };
    if (SEARCH_TOOLS.has(name)) return { state: 'running', key: 'tool_summary.searching' };
    return { state: 'running', key: 'tool_summary.working' };
  }

  if (tc.isError) return { state: 'error', key: 'tool_summary.error' };

  const result = tc.result ?? '';
  if (READ_TOOLS.has(name)) return { state: 'success', key: 'tool_summary.lines', params: { count: countLines(result) } };
  if (SEARCH_TOOLS.has(name)) return { state: 'success', key: 'tool_summary.matches', params: { count: countLines(result) } };
  if (name === 'Write') return { state: 'success', key: 'tool_summary.saved' };
  if (EDIT_TOOLS.has(name)) {
    const n = changeCount(tc.input);
    if (n !== null && n > 0) return { state: 'success', key: 'tool_summary.changes', params: { count: n } };
    return { state: 'success', key: 'tool_summary.edited' };
  }
  return { state: 'success', key: 'tool_summary.done' };
}
