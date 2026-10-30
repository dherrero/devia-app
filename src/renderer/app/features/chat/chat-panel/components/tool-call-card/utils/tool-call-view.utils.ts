import {
  LucideTerminal, LucidePencil, LucideFileEdit, LucideSave, LucideFileText,
  LucideSearch, LucideFileSearch, LucideHelpCircle, LucideGlobe,
  LucideClipboard, LucideSend,
  type LucideIcon,
} from '@lucide/angular';
import type { ToolCallRecord } from '../../../../../../../../shared/domain/chat';
import { formatTerminalCommandForDisplay } from '../../../../../../../../shared/domain/tool-call.helpers';

const TOOL_ICON_MAP: Record<string, LucideIcon> = {
  terminal:     LucideTerminal,
  edit:         LucidePencil,
  edit_note:    LucideFileEdit,
  save:         LucideSave,
  description:  LucideFileText,
  search:       LucideSearch,
  find_in_page: LucideFileSearch,
  help:         LucideHelpCircle,
  travel_explore: LucideGlobe,
  public:       LucideGlobe,
  assignment:   LucideClipboard,
  send:         LucideSend,
};

export function iconNameToLucide(name: string): LucideIcon | null {
  return TOOL_ICON_MAP[name] ?? null;
}

/** Shape of a single TodoWrite todo item (tolerates underscore/dash variants). */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** Attempts to parse `input.todos` from a TodoWrite call. Returns null on mismatch. */
export function parseTodos(input: unknown): TodoItem[] | null {
  if (input === null || typeof input !== 'object') return null;
  const todos = (input as Record<string, unknown>)['todos'];
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const result: TodoItem[] = [];
  for (const raw of todos) {
    if (raw === null || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const content = typeof item['content'] === 'string' ? item['content'] : null;
    if (!content) return null;
    const rawStatus = String(item['status'] ?? 'pending').toLowerCase().replace(/-/g, '_');
    const status: TodoItem['status'] =
      rawStatus === 'completed' ? 'completed'
      : rawStatus === 'in_progress' ? 'in_progress'
      : 'pending';
    result.push({ content, status });
  }
  return result.length > 0 ? result : null;
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Human-oriented one-shot formatting of a tool input (command, path, question or JSON). */
export function formatToolInput(tc: ToolCallRecord): string | null {
  if (!tc.input) return null;

  if (tc.name === 'Bash' || tc.name === 'Execute') {
    const inp = tc.input as { command?: string };
    return typeof inp.command === 'string'
      ? formatTerminalCommandForDisplay(inp.command)
      : safeStringify(tc.input);
  }
  if (tc.name === 'Edit' || tc.name === 'Write' || tc.name === 'MultiEdit') {
    const inp = tc.input as { file_path?: string; path?: string };
    return inp.file_path ?? inp.path ?? safeStringify(tc.input);
  }
  if (tc.name === 'Read') {
    const inp = tc.input as { file_path?: string; path?: string };
    return inp.file_path ?? inp.path ?? safeStringify(tc.input);
  }
  if (tc.name === 'AskUserQuestion') {
    const inp = tc.input as { question?: string };
    return inp.question ?? safeStringify(tc.input);
  }
  return safeStringify(tc.input);
}

const FILE_PATH_TOOLS = new Set([
  'Read', 'NotebookRead', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write', 'file_change',
]);

/**
 * Clean file path for file-oriented tools, or null. Handles Claude's
 * `{ file_path }`/`{ path }` inputs and the `{ changes: [{ path }] }` shape
 * the non-Claude agents (Codex/Gemini/OpenCode) normalise edits into, so the
 * card never falls back to dumping raw JSON where a path belongs.
 */
export function extractFilePath(tc: ToolCallRecord): string | null {
  if (!FILE_PATH_TOOLS.has(tc.name)) return null;
  const inp = tc.input;
  if (inp === null || typeof inp !== 'object') return null;
  const o = inp as { file_path?: unknown; path?: unknown; changes?: unknown };
  if (typeof o.file_path === 'string') return o.file_path;
  if (typeof o.path === 'string') return o.path;
  if (Array.isArray(o.changes)) {
    const first = o.changes.find((c) => c !== null && typeof c === 'object') as
      | { path?: unknown; file_path?: unknown } | undefined;
    if (typeof first?.path === 'string') return first.path;
    if (typeof first?.file_path === 'string') return first.file_path;
  }
  return null;
}
