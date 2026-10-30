import type { ChatMessage } from './chat';
import { toRelativePath } from './path-display';

/**
 * Transcript re-seeding for `continuity: 'replay'` agents (S-19 F0).
 *
 * Agents whose CLI exposes no clean resume handle (gemini, opencode) lose all
 * prior context between turns: the use case only sends the latest instruction
 * and there is no native session to resume. This pure helper renders the prior
 * conversation into a delimited block that the launcher prepends to the current
 * turn, so the agent regains the thread.
 *
 * No Node/Electron APIs — lives in shared/domain so main and tests share one
 * implementation, mirroring `handoff.ts`.
 */

export const REPLAY_MAX_TOTAL_CHARS = 12000;
export const REPLAY_MAX_CHARS_PER_MESSAGE = 2000;
export const REPLAY_TOUCHED_FILES_PER_TURN_CAP = 8;

const FILE_EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

export interface ConversationReplayOptions {
  /** Hard ceiling for the rendered block. The OLDEST turns are dropped first. */
  maxChars: number;
  maxCharsPerMessage?: number;
  /** When provided, touched files in tool summaries are shown workspace-relative. */
  workspaceRoot?: string;
}

interface ReplayTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Render the prior conversation as a re-seedable block, or `null` when there is
 * nothing to replay (first turn / no substantive messages). The block never
 * exceeds `maxChars`: turns are trimmed oldest-first, then hard-truncated as a
 * last resort, so the freshest exchange always survives.
 *
 * The caller passes the session's EXISTING messages — the current user
 * instruction is delivered separately as the actual turn and must not be
 * included here.
 */
export function buildConversationReplay(
  messages: readonly ChatMessage[],
  opts: ConversationReplayOptions,
): string | null {
  const maxCharsPerMessage = opts.maxCharsPerMessage ?? REPLAY_MAX_CHARS_PER_MESSAGE;
  let turns = collectTurns(messages, maxCharsPerMessage, opts.workspaceRoot);
  if (turns.length === 0) return null;

  let rendered = render(turns);
  while (rendered.length > opts.maxChars && turns.length > 1) {
    turns = turns.slice(1);
    rendered = render(turns);
  }
  if (rendered.length > opts.maxChars) {
    rendered = `${rendered.slice(0, Math.max(0, opts.maxChars - 1))}…`;
  }
  return rendered;
}

function collectTurns(
  messages: readonly ChatMessage[],
  maxCharsPerMessage: number,
  workspaceRoot?: string,
): ReplayTurn[] {
  const turns: ReplayTurn[] = [];
  for (const msg of messages) {
    if (msg.kind === 'handoff') continue;
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    let body = (msg.text ?? '').trim();
    if (msg.role === 'assistant') {
      const toolNote = summarizeToolCalls(msg.toolCalls, workspaceRoot);
      if (toolNote) body = body ? `${body}\n${toolNote}` : toolNote;
    }
    if (body.length === 0) continue;
    turns.push({ role: msg.role, text: clip(body, maxCharsPerMessage) });
  }
  return turns;
}

function summarizeToolCalls(
  calls: ChatMessage['toolCalls'],
  workspaceRoot?: string,
): string | null {
  if (!calls || calls.length === 0) return null;
  const names = new Set<string>();
  const files: string[] = [];
  const seenFiles = new Set<string>();
  for (const call of calls) {
    names.add(call.name);
    if (!FILE_EDITING_TOOLS.has(call.name)) continue;
    const raw = filePathFromInput(call.input);
    if (raw === undefined) continue;
    const display = workspaceRoot !== undefined ? toRelativePath(raw, workspaceRoot) : raw;
    if (seenFiles.has(display)) continue;
    seenFiles.add(display);
    files.push(display);
  }
  const parts = [`[herramientas: ${[...names].join(', ')}]`];
  if (files.length > 0) {
    const shown = files.slice(0, REPLAY_TOUCHED_FILES_PER_TURN_CAP);
    const suffix = files.length > shown.length ? ', …' : '';
    parts.push(`[ficheros: ${shown.join(', ')}${suffix}]`);
  }
  return parts.join(' ');
}

function filePathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as { file_path?: unknown; path?: unknown };
  if (typeof o.file_path === 'string' && o.file_path.length > 0) return o.file_path;
  if (typeof o.path === 'string' && o.path.length > 0) return o.path;
  return undefined;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function render(turns: readonly ReplayTurn[]): string {
  const lines: string[] = [
    '## Conversación previa (continúa esta misma sesión)',
    '',
    'Estos son los turnos anteriores de la conversación, incluidos para que conserves el contexto. El turno actual del usuario llega justo después de este bloque.',
    '',
  ];
  for (const t of turns) {
    lines.push(`- ${t.role === 'user' ? 'Usuario' : 'Asistente'}: ${t.text}`);
  }
  return lines.join('\n').trimEnd();
}
