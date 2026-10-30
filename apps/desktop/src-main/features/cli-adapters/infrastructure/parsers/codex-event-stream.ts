import type { AgentEvent, AgentEventSink, StreamParser } from '../../domain/stream-parser';
import { LineBuffer } from './line-buffer';

/**
 * Translator parser for `codex exec --json` (Codex 0.5+ "agentic" event
 * stream — `thread.started` / `turn.started` / `item.started` /
 * `item.completed` / `turn.completed`).
 *
 * Logic mirrors the reference Open Design daemon's `handleCodexEvent`
 * (re-implemented from event-shape knowledge, no code copied) so the
 * same event stream that runs against the upstream Codex CLI works
 * unchanged in Devia.
 *
 * Event shapes recognised:
 *   { type: 'thread.started', thread_id }
 *   { type: 'turn.started' }
 *   { type: 'item.started',   item: { id, type: 'command_execution', command } }
 *   { type: 'item.completed', item: { id, type: 'command_execution',
 *                                     command, aggregated_output, exit_code, status } }
 *   { type: 'item.completed', item: { type: 'agent_message', text } }
 *   { type: 'item.completed', item: { type: 'file_change', changes: [...] } }
 *   { type: 'turn.completed', usage: { input_tokens, output_tokens, cached_input_tokens, ... } }
 *   { type: 'turn.failed',    error: { message } }
 *   { type: 'error',          message }
 *
 * The older `agent_message_delta` / `exec_command_begin` shape is no
 * longer emitted by Codex 0.5+ and is intentionally not handled here.
 *
 * E-DSK-13 Fase D (context-recovery): Codex auto-compacts internally but no
 * distinct compaction event is observed here yet — only token counts on
 * `turn.completed`. When a real long session reveals the signal, emit
 * `{ type: 'context_compacted' }` so the runner re-injects memory (as the
 * Claude parser does). See docs/memory/03-compaction-recovery.md.
 */
interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    status?: string;
    changes?: unknown;
    /** mcp_tool_call items: server + tool + arguments + result/error. */
    server?: string;
    tool?: string;
    arguments?: unknown;
    result?: unknown;
    error?: unknown;
  };
  error?: { message?: string } | string;
  message?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
  [k: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function extractErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    if (typeof value['message'] === 'string') return value['message'];
    if (isRecord(value['error'])) {
      const inner = value['error'] as Record<string, unknown>;
      if (typeof inner['message'] === 'string') return inner['message'];
    }
  }
  return fallback;
}

/** Claude-style MCP tool name (`mcp__server__tool`) so both agents' MCP calls
 *  look the same to the chat UI / transcript / audit log. */
function mcpToolName(server: unknown, tool: unknown): string {
  const s = typeof server === 'string' && server ? server : 'mcp';
  const t = typeof tool === 'string' && tool ? tool : 'tool';
  return `mcp__${s}__${t}`;
}

/** Flatten an MCP result into readable text: join `content[].text` parts when
 *  present (the standard MCP shape), otherwise stringify the whole payload. */
function mcpResultText(result: unknown): string {
  if (isRecord(result) && Array.isArray(result['content'])) {
    const texts = (result['content'] as unknown[])
      .filter(isRecord)
      .map((p) => (typeof p['text'] === 'string' ? p['text'] : ''))
      .filter((t) => t.length > 0);
    if (texts.length > 0) return texts.join('\n');
  }
  return stringifyContent(result ?? '');
}

export function createCodexEventStreamParser(sink: AgentEventSink): StreamParser {
  const buf = new LineBuffer();

  // Per-instance state — parallel parsers must not share these.
  const codexToolUses = new Set<string>();
  let codexErrorEmitted = false;
  let previousEventWasAgentMessage = false;
  let lastAgentMessageEndedWithNewline = false;

  function handle(line: string): void {
    let obj: CodexEvent;
    try { obj = JSON.parse(line) as CodexEvent; } catch {
      sink({ type: 'raw', line });
      return;
    }
    const type = obj.type;

    // ── Errors ─────────────────────────────────────────────────────────────
    if (type === 'error') {
      const message = extractErrorMessage(obj.message ?? obj.error, 'Codex error');
      // "Reconnecting..." messages are recoverable — surface as status, not fatal.
      if (typeof message === 'string'
        && message.includes('Reconnecting...')
        && message.includes('timeout waiting for child process to exit')) {
        sink({ type: 'status', label: message });
        return;
      }
      if (!codexErrorEmitted) {
        codexErrorEmitted = true;
        sink({ type: 'error', message, classification: 'unknown' });
      }
      return;
    }

    if (type === 'turn.failed') {
      if (!codexErrorEmitted) {
        codexErrorEmitted = true;
        sink({
          type: 'error',
          message: extractErrorMessage(obj.error ?? obj.message, 'Codex turn failed'),
          classification: 'unknown',
        });
      }
      return;
    }

    // ── Status events ──────────────────────────────────────────────────────
    if (type === 'thread.started') {
      // T-7: thread.started carries model when Codex reports it.
      const model = typeof obj['model'] === 'string' ? obj['model'] : undefined;
      const status: AgentEvent = { type: 'status', label: 'initializing' };
      if (model !== undefined) status.model = model;
      sink(status);
      // The thread id is Codex's session handle: the runner stores it and the
      // next run resumes with `codex exec resume <id>` (conversational
      // continuity — without it every turn starts amnesiac).
      if (typeof obj.thread_id === 'string' && obj.thread_id.length > 0) {
        sink({ type: 'session_started', agentSessionId: obj.thread_id });
      }
      return;
    }
    if (type === 'turn.started') {
      previousEventWasAgentMessage = false;
      lastAgentMessageEndedWithNewline = false;
      sink({ type: 'status', label: 'running' });
      return;
    }

    // ── Tool use: command execution (begin) ────────────────────────────────
    if (type === 'item.started' && isRecord(obj.item)) {
      const item = obj.item;
      if (item.type === 'command_execution' && typeof item.id === 'string') {
        previousEventWasAgentMessage = false;
        lastAgentMessageEndedWithNewline = false;
        if (!codexToolUses.has(item.id)) {
          codexToolUses.add(item.id);
          sink({
            type: 'tool_use',
            id: item.id,
            name: 'Bash',
            input: { command: typeof item.command === 'string' ? item.command : '' },
          });
        }
        return;
      }
      // MCP tool calls (devia-kanban, devia-memory, …): translate to the same
      // tool_use/tool_result pair the chat UI and transcript already render,
      // using Claude's `mcp__<server>__<tool>` naming so downstream consumers
      // treat both agents' MCP calls uniformly. The result rides item.completed.
      if (item.type === 'mcp_tool_call' && typeof item.id === 'string') {
        previousEventWasAgentMessage = false;
        lastAgentMessageEndedWithNewline = false;
        if (!codexToolUses.has(item.id)) {
          codexToolUses.add(item.id);
          sink({
            type: 'tool_use',
            id: item.id,
            name: mcpToolName(item.server, item.tool),
            input: item.arguments ?? {},
          });
        }
        return;
      }
      // Other item.started kinds are emitted as raw for now.
      sink({ type: 'raw', line });
      return;
    }

    // ── Tool result: command execution (end) ───────────────────────────────
    if (type === 'item.completed' && isRecord(obj.item)) {
      const item = obj.item;

      if (item.type === 'command_execution' && typeof item.id === 'string') {
        previousEventWasAgentMessage = false;
        lastAgentMessageEndedWithNewline = false;
        // The matching item.started may have been missed (very fast commands
        // sometimes only emit completed); make sure the tool_use exists so the
        // tool_result has somewhere to attach.
        if (!codexToolUses.has(item.id)) {
          codexToolUses.add(item.id);
          sink({
            type: 'tool_use',
            id: item.id,
            name: 'Bash',
            input: { command: typeof item.command === 'string' ? item.command : '' },
          });
        }
        sink({
          type: 'tool_result',
          toolUseId: item.id,
          content: stringifyContent(item.aggregated_output ?? ''),
          isError: typeof item.exit_code === 'number'
            ? item.exit_code !== 0
            : item.status === 'failed',
        });
        return;
      }

      // Assistant text — Codex emits the full message in one shot per chunk.
      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.length > 0) {
        const text = item.text;
        // Insert a newline boundary between two consecutive agent_messages
        // so concatenated outputs don't run together visually.
        const needsBoundary =
          previousEventWasAgentMessage
          && !lastAgentMessageEndedWithNewline
          && !text.startsWith('\n');
        const delta = needsBoundary ? `\n${text}` : text;
        sink({ type: 'text_delta', delta });
        previousEventWasAgentMessage = true;
        lastAgentMessageEndedWithNewline = text.endsWith('\n');
        return;
      }

      // MCP tool call completed: ensure the tool_use exists (the started event
      // may have been missed), then attach the result. Errors surface either as
      // `status: 'failed'` or a non-null `error` payload.
      if (item.type === 'mcp_tool_call' && typeof item.id === 'string') {
        previousEventWasAgentMessage = false;
        lastAgentMessageEndedWithNewline = false;
        if (!codexToolUses.has(item.id)) {
          codexToolUses.add(item.id);
          sink({
            type: 'tool_use',
            id: item.id,
            name: mcpToolName(item.server, item.tool),
            input: item.arguments ?? {},
          });
        }
        const isError = item.status === 'failed' || (item.error !== null && item.error !== undefined);
        sink({
          type: 'tool_result',
          toolUseId: item.id,
          content: isError
            ? extractErrorMessage(item.error, 'MCP tool call failed')
            : mcpResultText(item.result),
          isError,
        });
        return;
      }

      // file_change items: surface as a synthetic tool_use/tool_result pair so
      // the chat UI sees the edit happened. Codex emits one per file batch.
      if (item.type === 'file_change' && typeof item.id === 'string') {
        if (!codexToolUses.has(item.id)) {
          codexToolUses.add(item.id);
          sink({
            type: 'tool_use',
            id: item.id,
            name: 'Edit',
            input: { changes: item.changes ?? [] },
          });
        }
        sink({
          type: 'tool_result',
          toolUseId: item.id,
          content: stringifyContent(item.changes ?? []),
          isError: false,
        });
        return;
      }

      sink({ type: 'raw', line });
      return;
    }

    // ── Usage / turn-end ───────────────────────────────────────────────────
    if (type === 'turn.completed' && isRecord(obj.usage)) {
      const ev: {
        type: 'usage';
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        reasoningOutputTokens?: number;
      } = { type: 'usage' };
      // OpenAI's `cached_input_tokens` is a SUBSET of `input_tokens`, while
      // AgentEvent follows Anthropic's split (input excludes cache, the
      // renderer adds both for the context bar). Subtract or it counts twice.
      const cached = typeof obj.usage.cached_input_tokens === 'number' ? obj.usage.cached_input_tokens : undefined;
      if (typeof obj.usage.input_tokens === 'number') {
        ev.inputTokens = Math.max(0, obj.usage.input_tokens - (cached ?? 0));
      }
      if (typeof obj.usage.output_tokens === 'number') ev.outputTokens = obj.usage.output_tokens;
      if (cached !== undefined) ev.cachedInputTokens = cached;
      if (typeof obj.usage.reasoning_output_tokens === 'number') ev.reasoningOutputTokens = obj.usage.reasoning_output_tokens;
      sink(ev);
      return;
    }

    // ── Unknown events — emit raw so nothing is silently dropped ──────────
    sink({ type: 'raw', line });
  }

  return {
    feed(chunk: string) {
      for (const line of buf.push(chunk)) handle(line);
    },
    flush() {
      const tail = buf.drain();
      if (tail) handle(tail);
    },
  };
}
