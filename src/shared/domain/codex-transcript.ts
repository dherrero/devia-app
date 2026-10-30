import type { ChatMessage } from './chat';
import type { ParsedTranscript } from './agent-transcript';
import type { PersistedAgentEvent } from './persisted-agent-event';
import { rebuildFromEvents } from './persisted-agent-event';

/**
 * Parses an OpenAI Codex CLI rollout transcript
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`) into Devia's
 * `ChatMessage[]` plus the metadata needed to persist it.
 *
 * Pure domain code: NO Node/Electron imports. Reading the file off disk is the
 * infrastructure layer's job.
 *
 * Rollout shape (verified against codex 0.141.0):
 *   - line 1: `{ type:'session_meta', payload:{ id, cwd, timestamp } }` — `id`
 *     is the rollout uuid, identical to the filename uuid and the argument
 *     `codex exec resume <id>` accepts → native resume, like Claude.
 *   - `{ type:'response_item', payload:{ type:'message', role, content[] } }` —
 *     user (`input_text`) / assistant (`output_text`) turns.
 *   - `{ type:'response_item', payload:{ type:'function_call', name, arguments,
 *     call_id } }` and `function_call_output` ({ call_id, output }) — tool calls.
 *   - `reasoning` items are encrypted (no plaintext) → skipped.
 *   - `event_msg` / `turn_context` records mirror the above and are ignored;
 *     `response_item` is the canonical transcript.
 *
 * One whole agentic turn (assistant text → tool calls → results → …) is
 * aggregated into ONE assistant `ChatMessage`, matching how Devia persists a
 * live run (and the Claude importer).
 */

interface CodexContentBlock {
  type?: unknown;
  text?: unknown;
}

interface CodexPayload {
  type?: unknown;
  id?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  role?: unknown;
  content?: unknown;
  name?: unknown;
  arguments?: unknown;
  call_id?: unknown;
  output?: unknown;
  input?: unknown;
  summary?: unknown;
}

interface CodexLine {
  type?: unknown;
  timestamp?: unknown;
  payload?: CodexPayload | undefined;
}

function splitLines(text: string): CodexLine[] {
  const out: CodexLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') out.push(obj as CodexLine);
    } catch {
      /* tolerate a truncated/corrupt line */
    }
  }
  return out;
}

function toMs(ts: unknown): number | null {
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/** Join the text blocks of a message `content` (input_text/output_text/text). */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (!b || typeof b !== 'object') return '';
      const block = b as CodexContentBlock;
      const t = block.type;
      if (t === 'input_text' || t === 'output_text' || t === 'text') {
        return typeof block.text === 'string' ? block.text : '';
      }
      return '';
    })
    .join('');
}

/**
 * Codex prepends synthetic blocks to the FIRST user message (the repo's
 * AGENTS.md echo + an `<environment_context>` block). They are not something
 * the human typed, so they're dropped from the user text — otherwise every
 * imported Codex session would preview as "# AGENTS.md instructions…".
 */
function isInjectedUserBlock(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<environment_context>') || /^#\s*AGENTS\.md instructions\b/.test(t);
}

function userText(content: unknown): string {
  if (typeof content === 'string') return isInjectedUserBlock(content) ? '' : content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (!b || typeof b !== 'object') return '';
      const block = b as CodexContentBlock;
      if (block.type !== 'input_text' && block.type !== 'text') return '';
      const text = typeof block.text === 'string' ? block.text : '';
      return isInjectedUserBlock(text) ? '' : text;
    })
    .join('');
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function parseCodexTranscript(text: string): ParsedTranscript | null {
  const lines = splitLines(text);
  const messages: ChatMessage[] = [];
  let agentSessionId = '';
  let cwd = '';
  let title: string | undefined;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  // In-flight assistant turn aggregation.
  let curEvents: PersistedAgentEvent[] = [];
  let hasAssistant = false;

  const flushAssistant = (): void => {
    if (!hasAssistant || curEvents.length === 0) {
      curEvents = []; hasAssistant = false;
      return;
    }
    const rebuilt = rebuildFromEvents(curEvents);
    messages.push({
      id: `codex-asst-${messages.length}`,
      role: 'assistant',
      agentId: 'codex',
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

  for (const line of lines) {
    const ts = toMs(line.timestamp);
    if (ts !== null) {
      if (firstTs === null) firstTs = ts;
      lastTs = ts;
    }

    const payload = line.payload;
    if (!payload || typeof payload !== 'object') continue;

    if (line.type === 'session_meta') {
      if (typeof payload.id === 'string' && !agentSessionId) agentSessionId = payload.id;
      if (typeof payload.cwd === 'string' && !cwd) cwd = payload.cwd;
      const metaTs = toMs(payload.timestamp);
      if (metaTs !== null && firstTs === null) firstTs = metaTs;
      continue;
    }

    if (line.type !== 'response_item') continue;

    switch (payload.type) {
      case 'message': {
        const role = payload.role;
        if (role === 'user') {
          const t = userText(payload.content);
          if (t.trim()) {
            flushAssistant();
            messages.push({ id: `codex-user-${messages.length}`, role: 'user', text: t });
            if (title === undefined) title = t.replace(/\s+/g, ' ').trim().slice(0, 80);
          }
        } else if (role === 'assistant') {
          const t = blockText(payload.content);
          if (t) {
            hasAssistant = true;
            curEvents.push({ kind: 'text', text: t });
          }
        }
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        if (typeof payload.call_id === 'string' && typeof payload.name === 'string') {
          hasAssistant = true;
          const input = payload.type === 'function_call'
            ? parseArguments(payload.arguments)
            : payload.input;
          curEvents.push({ kind: 'tool_use', id: payload.call_id, name: payload.name, input });
        }
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        if (typeof payload.call_id === 'string') {
          const content = typeof payload.output === 'string'
            ? payload.output
            : blockText(payload.output);
          curEvents.push({ kind: 'tool_result', toolUseId: payload.call_id, content, isError: false });
        }
        break;
      }
      default:
        break; // reasoning (encrypted), etc.
    }
  }

  flushAssistant();

  if (messages.length === 0 || !agentSessionId || !cwd) return null;

  return {
    agentId: 'codex',
    agentSessionId,
    messages,
    createdAt: firstTs ?? Date.now(),
    updatedAt: lastTs ?? firstTs ?? Date.now(),
    cwd,
    resumable: true,
    ...(title !== undefined && { title }),
  };
}
