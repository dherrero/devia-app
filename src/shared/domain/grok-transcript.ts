import type { ChatMessage } from './chat';
import type { ParsedTranscript } from './agent-transcript';
import type { PersistedAgentEvent } from './persisted-agent-event';
import { rebuildFromEvents } from './persisted-agent-event';

/**
 * Parses a grok-dev session exported from its SQLite store
 * (`~/.grok/grok.db`) into Devia's `ChatMessage[]` + metadata. The
 * infrastructure reader (`fs-grok-sessions-reader.ts`) materialises a session
 * (its `sessions` row + ordered `messages` rows) into the JSON this pure parser
 * consumes — no DB/Node access here.
 *
 * Each `message.messageJson` is an AI-SDK `ModelMessage`
 * (role user/assistant/tool/system; content string or part array). One whole
 * agentic turn (assistant text → tool-call → tool-result → …) is aggregated
 * into a single assistant `ChatMessage`, matching the Claude/Codex importers.
 *
 * grok-dev resumes natively (`grok --session <id>`), so `resumable` is true:
 * the imported session reuses the grok session id, and continuing it recovers
 * the full conversation from grok's own store.
 */

export interface GrokRawMessage {
  seq?: unknown;
  role?: unknown;
  messageJson?: unknown;
}
export interface GrokRawSession {
  id?: unknown;
  title?: unknown;
  cwdLast?: unknown;
  cwdAtStart?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}
export interface GrokRawExport {
  session?: GrokRawSession;
  messages?: GrokRawMessage[];
}

interface AiSdkPart {
  type?: unknown;
  text?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  input?: unknown;
  args?: unknown;
  output?: unknown;
  result?: unknown;
}

function toMs(ts: unknown): number | null {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

function partText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      if (!p || typeof p !== 'object') return '';
      const part = p as AiSdkPart;
      return (part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string'
        ? part.text
        : '';
    })
    .join('');
}

function stringifyOutput(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as AiSdkPart;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.output === 'string') return o.output;
    try { return JSON.stringify(v); } catch { return ''; }
  }
  return String(v);
}

export function parseGrokTranscript(text: string): ParsedTranscript | null {
  let raw: GrokRawExport;
  try {
    raw = JSON.parse(text) as GrokRawExport;
  } catch {
    return null;
  }
  const session = raw.session;
  if (!session || typeof session.id !== 'string' || !session.id) return null;
  const cwd = typeof session.cwdLast === 'string' && session.cwdLast
    ? session.cwdLast
    : (typeof session.cwdAtStart === 'string' ? session.cwdAtStart : '');
  if (!cwd) return null;

  const messages: ChatMessage[] = [];
  let curEvents: PersistedAgentEvent[] = [];
  let hasAssistant = false;
  let title = typeof session.title === 'string' && session.title.trim() ? session.title.trim() : undefined;

  const flushAssistant = (): void => {
    if (!hasAssistant || curEvents.length === 0) { curEvents = []; hasAssistant = false; return; }
    const rebuilt = rebuildFromEvents(curEvents);
    messages.push({
      id: `grok-asst-${messages.length}`,
      role: 'assistant',
      agentId: 'grok',
      runStatus: 'succeeded',
      events: curEvents,
      text: rebuilt.text,
      thinking: rebuilt.thinking,
      toolCalls: rebuilt.toolCalls,
      contentBlocks: rebuilt.contentBlocks,
      ...(rebuilt.usage !== undefined && { usage: rebuilt.usage }),
    });
    curEvents = []; hasAssistant = false;
  };

  const rows = Array.isArray(raw.messages) ? [...raw.messages] : [];
  rows.sort((a, b) => (typeof a.seq === 'number' ? a.seq : 0) - (typeof b.seq === 'number' ? b.seq : 0));

  for (const row of rows) {
    let mj: { role?: unknown; content?: unknown };
    try {
      mj = typeof row.messageJson === 'string' ? JSON.parse(row.messageJson) : (row.messageJson as typeof mj);
    } catch {
      continue;
    }
    if (!mj || typeof mj !== 'object') continue;
    const role = typeof mj.role === 'string' ? mj.role : (typeof row.role === 'string' ? row.role : '');
    const content = mj.content;

    if (role === 'user') {
      const t = partText(content);
      if (t.trim()) {
        flushAssistant();
        messages.push({ id: `grok-user-${messages.length}`, role: 'user', text: t });
        if (title === undefined) title = t.replace(/\s+/g, ' ').trim().slice(0, 80);
      }
      continue;
    }

    if (role === 'tool') {
      // Tool-result message(s) belong to the in-flight assistant turn.
      if (Array.isArray(content)) {
        for (const p of content) {
          if (!p || typeof p !== 'object') continue;
          const part = p as AiSdkPart;
          if (part.type !== 'tool-result' || typeof part.toolCallId !== 'string') continue;
          curEvents.push({
            kind: 'tool_result',
            toolUseId: part.toolCallId,
            content: stringifyOutput(part.output ?? part.result),
            isError: false,
          });
        }
      }
      continue;
    }

    if (role === 'assistant') {
      hasAssistant = true;
      if (typeof content === 'string') {
        if (content) curEvents.push({ kind: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const p of content) {
          if (!p || typeof p !== 'object') continue;
          const part = p as AiSdkPart;
          if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string' && part.text) {
            curEvents.push({ kind: part.type === 'reasoning' ? 'thinking' : 'text', text: part.text });
          } else if (part.type === 'tool-call' && typeof part.toolCallId === 'string') {
            curEvents.push({
              kind: 'tool_use',
              id: part.toolCallId,
              name: typeof part.toolName === 'string' ? part.toolName : 'tool',
              input: part.input ?? part.args ?? {},
            });
          }
        }
      }
      continue;
    }
    // system / unknown roles are skipped.
  }

  flushAssistant();

  if (messages.length === 0) return null;

  const createdAt = toMs(session.createdAt) ?? Date.now();
  const updatedAt = toMs(session.updatedAt) ?? createdAt;

  return {
    agentId: 'grok',
    agentSessionId: session.id,
    messages,
    createdAt,
    updatedAt,
    cwd,
    resumable: true,
    ...(title !== undefined && { title }),
  };
}
