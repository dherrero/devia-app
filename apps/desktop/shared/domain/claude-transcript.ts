import type { ChatMessage } from './chat';
import type { PersistedAgentEvent } from './persisted-agent-event';
import { rebuildFromEvents } from './persisted-agent-event';

/**
 * Parses a Claude Code transcript (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`)
 * into Devia's `ChatMessage[]` plus the session metadata needed to persist it.
 *
 * Pure domain code: NO Node/Electron imports. Reading the file off disk and
 * splitting it into lines is the infrastructure layer's job; this module only
 * transforms already-parsed JSONL objects.
 *
 * The whole agentic loop of one user turn (assistant text → tool_use →
 * tool_result → assistant text → …) is aggregated into ONE assistant
 * `ChatMessage`, matching how Devia persists a live run: a single assistant
 * message whose `events[]` interleave text, thinking, tool calls and their
 * results. Tool results live in Claude's *user* lines, so a user line that is
 * solely tool_result(s) is folded into the in-flight assistant message rather
 * than rendered as a user bubble.
 */

export interface ParsedClaudeTranscript {
  messages: ChatMessage[];
  /** Claude's native conversation id (= the file's UUID). Enables `--resume`. */
  agentSessionId: string;
  createdAt: number;
  updatedAt: number;
  /** Absolute cwd the session ran in, read from the transcript (never the
   *  lossy directory name). */
  cwd: string;
  title?: string;
  gitBranch?: string;
}

interface ClaudeContentBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

interface ClaudeLine {
  type?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  isSidechain?: unknown;
  aiTitle?: unknown;
  message?: {
    id?: unknown;
    role?: unknown;
    model?: unknown;
    content?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown } | undefined;
  } | undefined;
}

/** Parse the raw `.jsonl` text: one JSON object per line, skipping blank/bad lines. */
export function splitTranscriptLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
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

/** Normalise a tool_result `content` (string | block[] | other) to a string. */
function stringifyResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
          return (b as { text: string }).text;
        }
        return typeof b === 'string' ? b : '';
      })
      .join('');
  }
  return '';
}

/** Extract the visible user text from a user line's `content`. */
function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is ClaudeContentBlock => !!b && typeof b === 'object' && (b as ClaudeContentBlock).type === 'text')
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('');
  }
  return '';
}

/** Collect the tool_result blocks from a user line's `content`. */
function toolResults(content: unknown): Array<{ id: string; content: string; isError: boolean }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; content: string; isError: boolean }> = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const block = b as ClaudeContentBlock;
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    out.push({
      id: block.tool_use_id,
      content: stringifyResultContent(block.content),
      isError: block.is_error === true,
    });
  }
  return out;
}

export function parseClaudeTranscript(lines: readonly unknown[]): ParsedClaudeTranscript | null {
  const messages: ChatMessage[] = [];
  let agentSessionId = '';
  let cwd = '';
  let gitBranch: string | undefined;
  let title: string | undefined;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  // In-flight assistant turn aggregation.
  let curEvents: PersistedAgentEvent[] = [];
  let curId: string | null = null;
  let curModel: string | undefined;
  let curStartedAt: number | undefined;
  let curEndedAt: number | undefined;
  let hasAssistant = false;

  const flushAssistant = (): void => {
    if (!hasAssistant || curEvents.length === 0) {
      curEvents = []; curId = null; curModel = undefined; curStartedAt = undefined; curEndedAt = undefined; hasAssistant = false;
      return;
    }
    const rebuilt = rebuildFromEvents(curEvents);
    const msg: ChatMessage = {
      id: curId ?? `claude-asst-${messages.length}`,
      role: 'assistant',
      agentId: 'claude',
      runStatus: 'succeeded',
      events: curEvents,
      text: rebuilt.text,
      thinking: rebuilt.thinking,
      toolCalls: rebuilt.toolCalls,
      contentBlocks: rebuilt.contentBlocks,
      ...(rebuilt.usage !== undefined && { usage: rebuilt.usage }),
      ...(curModel !== undefined && { model: curModel }),
      ...(curStartedAt !== undefined && { startedAt: curStartedAt }),
      ...(curEndedAt !== undefined && { endedAt: curEndedAt }),
    };
    messages.push(msg);
    curEvents = []; curId = null; curModel = undefined; curStartedAt = undefined; curEndedAt = undefined; hasAssistant = false;
  };

  for (const raw of lines) {
    if (!raw || typeof raw !== 'object') continue;
    const line = raw as ClaudeLine;

    if (line.isSidechain === true) continue; // subagent transcript, not the main thread

    if (typeof line.sessionId === 'string' && !agentSessionId) agentSessionId = line.sessionId;
    if (typeof line.cwd === 'string' && !cwd) cwd = line.cwd;
    if (typeof line.gitBranch === 'string' && gitBranch === undefined && line.gitBranch) gitBranch = line.gitBranch;

    const ts = toMs(line.timestamp);
    if (ts !== null) {
      if (firstTs === null) firstTs = ts;
      lastTs = ts;
    }

    const type = line.type;
    if (type === 'ai-title') {
      if (typeof line.aiTitle === 'string' && line.aiTitle.trim()) title = line.aiTitle.trim();
      continue;
    }
    if (type !== 'user' && type !== 'assistant') continue; // attachment, queue-operation, summary, system, …

    const content = line.message?.content;

    if (type === 'user') {
      const results = toolResults(content);
      if (results.length > 0) {
        // Tool results belong to the in-flight assistant turn, not a new bubble.
        for (const r of results) {
          curEvents.push({ kind: 'tool_result', toolUseId: r.id, content: r.content, isError: r.isError });
        }
      }
      const text = userText(content);
      if (text.trim()) {
        flushAssistant();
        messages.push({
          id: typeof line.uuid === 'string' ? line.uuid : `claude-user-${messages.length}`,
          role: 'user',
          text,
        });
        if (title === undefined) title = text.replace(/\s+/g, ' ').trim().slice(0, 80);
      }
      continue;
    }

    // assistant
    if (!Array.isArray(content)) continue;
    hasAssistant = true;
    if (curId === null && typeof line.uuid === 'string') curId = line.uuid;
    if (typeof line.message?.model === 'string') curModel = line.message.model;
    if (curStartedAt === undefined && ts !== null) curStartedAt = ts;
    if (ts !== null) curEndedAt = ts;

    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      const block = b as ClaudeContentBlock;
      if (block.type === 'thinking') {
        if (typeof block.thinking === 'string' && block.thinking) {
          curEvents.push({ kind: 'thinking', text: block.thinking });
        }
      } else if (block.type === 'text') {
        if (typeof block.text === 'string' && block.text) {
          curEvents.push({ kind: 'text', text: block.text });
        }
      } else if (block.type === 'tool_use') {
        if (typeof block.id === 'string' && typeof block.name === 'string') {
          curEvents.push({ kind: 'tool_use', id: block.id, name: block.name, input: block.input });
        }
      }
    }

    const usage = line.message?.usage;
    if (usage && typeof usage === 'object') {
      const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
      const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
      if (inputTokens !== undefined || outputTokens !== undefined) {
        curEvents.push({
          kind: 'usage',
          ...(inputTokens !== undefined && { inputTokens }),
          ...(outputTokens !== undefined && { outputTokens }),
        });
      }
    }
  }

  flushAssistant();

  if (messages.length === 0 || !agentSessionId || !cwd) return null;

  return {
    messages,
    agentSessionId,
    createdAt: firstTs ?? Date.now(),
    updatedAt: lastTs ?? firstTs ?? Date.now(),
    cwd,
    ...(title !== undefined && { title }),
    ...(gitBranch !== undefined && { gitBranch }),
  };
}
