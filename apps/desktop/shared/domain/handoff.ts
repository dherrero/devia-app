import type { ChatMessage } from './chat';
import { extractSessionIdentity } from './session';
import { toRelativePath } from './path-display';

/**
 * Cross-agent session handoff brief (S-2 F2.1).
 *
 * Pure, deterministic transcript digest injected into the first run of a NEW
 * agent continuing a session another agent started: last substantial goal,
 * touched files, and a verbatim tail of the conversation. No Node/Electron
 * APIs — lives in shared/domain so main and tests share one implementation.
 */

export const HANDOFF_TAIL_TURNS = 4;
export const HANDOFF_MAX_CHARS_PER_MESSAGE = 1500;
export const HANDOFF_MAX_TOTAL_CHARS = 6000;
export const HANDOFF_TOUCHED_FILES_CAP = 30;
/** A user prompt shorter than this ("ok", "sí", "continúa") is not a goal. */
export const HANDOFF_MIN_GOAL_CHARS = 10;

const FILE_EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

export interface HandoffBriefOptions {
  tailTurns?: number;
  maxCharsPerMessage?: number;
  maxTotalChars?: number;
  /** When provided, touched files are shown workspace-relative. */
  workspaceRoot?: string;
  /**
   * F2.3: LLM-compressed summary of the transcript's middle section. When
   * present it renders as an extra section between the touched files and the
   * verbatim tail; the brief stays byte-identical to the deterministic one
   * when absent. Trimmed LAST under the total cap (it replaces information
   * the tail/files trimming would otherwise lose).
   */
  summaryBody?: string;
}

export interface HandoffTailEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface HandoffBrief {
  fromAgentId?: string;
  goal?: string;
  touchedFiles: string[];
  tail: HandoffTailEntry[];
  /** Ready-to-inject markdown block. Reflects the post-cap tail/files. */
  rendered: string;
}

export function buildHandoffBrief(
  messages: readonly ChatMessage[],
  opts: HandoffBriefOptions = {},
): HandoffBrief {
  const tailTurns = opts.tailTurns ?? HANDOFF_TAIL_TURNS;
  const maxCharsPerMessage = opts.maxCharsPerMessage ?? HANDOFF_MAX_CHARS_PER_MESSAGE;
  const maxTotalChars = opts.maxTotalChars ?? HANDOFF_MAX_TOTAL_CHARS;

  const fromAgentId = extractSessionIdentity(messages as unknown[]).agentId;
  const goal = findGoal(messages);
  let touchedFiles = collectTouchedFiles(messages, opts.workspaceRoot);
  let tail = collectTail(messages, tailTurns, maxCharsPerMessage);
  const summaryBody = opts.summaryBody?.trim() || undefined;

  let rendered = render(fromAgentId, goal, touchedFiles, tail, summaryBody);
  // Cap budget: drop the OLDEST tail entries first, then trim the file list,
  // and as a last resort hard-truncate — the freshest exchange survives.
  while (rendered.length > maxTotalChars && tail.length > 0) {
    tail = tail.slice(1);
    rendered = render(fromAgentId, goal, touchedFiles, tail, summaryBody);
  }
  while (rendered.length > maxTotalChars && touchedFiles.length > 0) {
    touchedFiles = touchedFiles.slice(0, -1);
    rendered = render(fromAgentId, goal, touchedFiles, tail, summaryBody);
  }
  if (rendered.length > maxTotalChars) {
    rendered = `${rendered.slice(0, Math.max(0, maxTotalChars - 1))}…`;
  }

  return {
    ...(fromAgentId !== undefined && { fromAgentId }),
    ...(goal !== undefined && { goal }),
    touchedFiles,
    tail,
    rendered,
  };
}

function findGoal(messages: readonly ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;
    const text = (msg.text ?? '').trim();
    if (text.length >= HANDOFF_MIN_GOAL_CHARS) return text;
  }
  return undefined;
}

function collectTouchedFiles(
  messages: readonly ChatMessage[],
  workspaceRoot?: string,
): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const msg of messages) {
    for (const call of msg.toolCalls ?? []) {
      if (!FILE_EDITING_TOOLS.has(call.name)) continue;
      const raw = filePathFromInput(call.input);
      if (raw === undefined) continue;
      const display = workspaceRoot !== undefined ? toRelativePath(raw, workspaceRoot) : raw;
      if (seen.has(display)) continue;
      seen.add(display);
      files.push(display);
      if (files.length >= HANDOFF_TOUCHED_FILES_CAP) return files;
    }
  }
  return files;
}

function filePathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as { file_path?: unknown; path?: unknown };
  if (typeof o.file_path === 'string' && o.file_path.length > 0) return o.file_path;
  if (typeof o.path === 'string' && o.path.length > 0) return o.path;
  return undefined;
}

function collectTail(
  messages: readonly ChatMessage[],
  tailTurns: number,
  maxCharsPerMessage: number,
): HandoffTailEntry[] {
  const entries: HandoffTailEntry[] = [];
  for (let i = messages.length - 1; i >= 0 && entries.length < tailTurns; i--) {
    const msg = messages[i];
    if (msg?.role !== 'user' && msg?.role !== 'assistant') continue;
    const text = (msg.text ?? '').trim();
    if (text.length === 0) continue;
    entries.unshift({ role: msg.role, text: clip(text, maxCharsPerMessage) });
  }
  return entries;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function render(
  fromAgentId: string | undefined,
  goal: string | undefined,
  touchedFiles: readonly string[],
  tail: readonly HandoffTailEntry[],
  summaryBody?: string,
): string {
  const lines: string[] = [];
  lines.push(`## Continuación de sesión iniciada con ${fromAgentId ?? 'otro agente'}`);
  lines.push('');
  if (goal !== undefined) {
    lines.push(`**Objetivo en curso:** ${goal}`);
    lines.push('');
  }
  if (touchedFiles.length > 0) {
    lines.push('**Ficheros tocados:**');
    for (const file of touchedFiles) lines.push(`- ${file}`);
    lines.push('');
  }
  if (summaryBody !== undefined) {
    lines.push('**Resumen de la sesión:**');
    lines.push(summaryBody);
    lines.push('');
  }
  if (tail.length > 0) {
    lines.push('**Últimos intercambios:**');
    for (const entry of tail) {
      lines.push(`- ${entry.role === 'user' ? 'Usuario' : 'Asistente'}: ${entry.text}`);
    }
  }
  return lines.join('\n').trimEnd();
}
