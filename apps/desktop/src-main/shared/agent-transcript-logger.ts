import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentEvent } from '../../shared/domain/agent-event';
import type { RunGatewayEvent } from './run-gateway';

/**
 * Human-readable agent transcript for dev sessions (request: a readable log of
 * "everything the agents answer" in `npm run dev:all:live`, without losing
 * detail). Subscribes to the {@link RunGateway} — the single point every run's
 * lifecycle flows through (renderer, Telegram and relay/mobile alike) — and
 * renders a Markdown transcript to disk.
 *
 * Unlike {@link JsonlRunEventLog} (machine replay) and {@link FileAgentAuditLog}
 * (compliance, no content), this is a developer reading aid: each run gets a
 * header marking the active agent + model + project + time, the assistant's
 * reply and thinking are buffered and written whole (never chopped into the raw
 * stream's deltas), and tool calls/results are rendered as fenced blocks.
 *
 * One file per dev session at `<dir>/session-<ts>.md`, mirrored to
 * `<dir>/latest.md` (truncated at boot) so the current session is always one
 * click away. Best-effort: every I/O error is swallowed so the logger can never
 * break the run pipeline (the gateway already isolates throwing listeners, but
 * we degrade gracefully regardless).
 */

/** Retention window for {@link purgeOldTranscripts}. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Tool inputs/results longer than this are cut — this is a reading aid, the
 *  full payload lives in the JSONL replay log. */
const MAX_BLOCK_CHARS = 2000;

export interface AgentTranscriptLoggerOptions {
  /** Directory holding the session transcripts (e.g. `<deviaDir>/agent-logs`). */
  dir: string;
  /** Session start — stamps the `session-<ts>.md` filename and the boot header. */
  startedAt: Date;
  /** Resolves the configured model for an agent (config lookup), used until a
   *  `status` event confirms the live model. */
  modelFor?: (agentId: string) => string | undefined;
}

interface RunState {
  runId: string;
  agentId?: string;
  model?: string;
  /** Buffered assistant text — flushed whole so the reply reads as one message. */
  assistantBuf: string;
  /** Buffered thinking text — flushed whole, same reasoning. */
  thinkingBuf: string;
  /** tool_use id → display name, so results/errors can name their tool. */
  toolNames: Map<string, string>;
}

export class AgentTranscriptLogger {
  readonly #sessionFile: string;
  readonly #latestFile: string;
  readonly #modelFor?: (agentId: string) => string | undefined;
  /** One active run per project. */
  readonly #runs = new Map<string, RunState>();

  constructor(opts: AgentTranscriptLoggerOptions) {
    this.#sessionFile = path.join(opts.dir, `session-${stampForFilename(opts.startedAt)}.md`);
    this.#latestFile = path.join(opts.dir, 'latest.md');
    if (opts.modelFor) this.#modelFor = opts.modelFor;

    try {
      fs.mkdirSync(opts.dir, { recursive: true });
    } catch {
      /* surfaced (and swallowed) on the first write */
    }
    // Reset latest.md so it always reflects the current session, not the last.
    try {
      fs.writeFileSync(this.#latestFile, '');
    } catch {
      /* best-effort */
    }
    this.#write(`# Sesión de agentes — ${formatStamp(opts.startedAt)}\n\n`);
  }

  /** Wire this into `runGateway.subscribe(logger.onEvent)`. */
  onEvent = (event: RunGatewayEvent): void => {
    switch (event.type) {
      case 'start':
        this.#onStart(event.project, event.runId, event.agentId);
        break;
      case 'output':
        this.#onOutput(event.project, event.line);
        break;
      case 'end':
        this.#onEnd(event.project, event.code, event.error);
        break;
    }
  };

  #onStart(project: string, runId: string | undefined, agentId?: string): void {
    const id = runId ?? `run-${this.#runs.size + 1}`;
    const model = agentId ? this.#modelFor?.(agentId) : undefined;
    const state: RunState = {
      runId: id,
      assistantBuf: '',
      thinkingBuf: '',
      toolNames: new Map(),
      ...(agentId !== undefined && { agentId }),
      ...(model !== undefined && { model }),
    };
    this.#runs.set(project, state);
    this.#write(
      `\n## ▶ ${id} · ${agentId ?? 'agente'} · ${model ?? 'modelo desconocido'}\n` +
        `${formatStamp(new Date())} · proyecto: ${project}\n\n`,
    );
  }

  #onOutput(project: string, line: string): void {
    const state = this.#ensureState(project);
    const event = parseAgentEvent(line);
    switch (event.type) {
      case 'status':
        if (event.model) {
          state.model = event.model;
          this.#write(`> _${event.label}_ · modelo: \`${event.model}\`\n\n`);
        }
        break;
      case 'text_delta':
        state.assistantBuf += event.delta;
        break;
      case 'thinking_delta':
        state.thinkingBuf += event.delta;
        break;
      case 'tool_use': {
        this.#flush(state);
        const display = displayToolName(event.name);
        state.toolNames.set(event.id, display);
        this.#write(
          `### 🔧 ${display}\n` +
            fence(truncate(stringifyInput(event.input)), 'json') +
            '\n',
        );
        break;
      }
      case 'tool_result': {
        // An errored result with no message is pure noise — skip the block.
        const content = event.content.trim();
        if (event.isError && content === '') break;
        const tool = state.toolNames.get(event.toolUseId);
        const label = event.isError
          ? `⚠️ Error del tool${tool ? ` (${tool})` : ''}`
          : `→ Resultado${tool ? ` (${tool})` : ''}`;
        this.#write(`${label}\n` + fence(truncate(content)) + '\n');
        break;
      }
      case 'error':
        this.#flush(state);
        this.#write(
          `### ⛔ Error${event.classification ? ` (${event.classification})` : ''}\n` +
            fence(event.message) +
            '\n',
        );
        break;
      case 'usage':
        this.#write(`> 📊 ${formatUsage(event)}\n\n`);
        break;
      case 'turn_end':
        this.#flush(state);
        break;
      case 'context_compacted':
        this.#flush(state);
        this.#write(`> ♻️ Contexto compactado${event.trigger ? ` (${event.trigger})` : ''}\n\n`);
        break;
      case 'raw':
        this.#write(fence(event.line) + '\n');
        break;
      case 'session_started':
      case 'thinking_start':
        break;
    }
  }

  #onEnd(project: string, code: number | null, error?: string): void {
    const state = this.#runs.get(project);
    if (!state) return;
    this.#flush(state);
    const status = code === 0 ? 'succeeded' : 'failed';
    this.#write(
      `### ${code === 0 ? '✅' : '❌'} Fin · ${status}` +
        ` · code ${code ?? 'null'}${error ? ` · ${error}` : ''}\n`,
    );
    this.#runs.delete(project);
  }

  /** Output before a start (shouldn't happen) lazily opens a run. */
  #ensureState(project: string): RunState {
    const existing = this.#runs.get(project);
    if (existing) return existing;
    const state: RunState = {
      runId: `run-${this.#runs.size + 1}`,
      assistantBuf: '',
      thinkingBuf: '',
      toolNames: new Map(),
    };
    this.#runs.set(project, state);
    return state;
  }

  /** Write buffered thinking + assistant text as whole messages, then clear. */
  #flush(state: RunState): void {
    if (state.thinkingBuf.trim()) {
      this.#write(`### 🧠 Thinking\n${state.thinkingBuf.trim()}\n\n`);
    }
    if (state.assistantBuf.trim()) {
      this.#write(`### 💬 Respuesta\n${state.assistantBuf.trim()}\n\n`);
    }
    state.thinkingBuf = '';
    state.assistantBuf = '';
  }

  /** Append the same Markdown to the session file and the latest mirror. */
  #write(md: string): void {
    for (const file of [this.#sessionFile, this.#latestFile]) {
      try {
        fs.appendFileSync(file, md);
      } catch {
        /* best-effort — a dead disk must never break the run */
      }
    }
  }
}

/**
 * Best-effort deletion of session transcripts older than the retention window.
 * Call once at boot so the directory does not grow without bound.
 */
export function purgeOldTranscripts(opts: { dir: string; now?: () => Date }): void {
  if (!fs.existsSync(opts.dir)) return;
  const cutoff = (opts.now?.() ?? new Date()).getTime() - MAX_AGE_MS;
  let files: string[];
  try {
    files = fs.readdirSync(opts.dir);
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.startsWith('session-') || !file.endsWith('.md')) continue;
    const filePath = path.join(opts.dir, file);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
    } catch {
      /* swallow — housekeeping, not load-bearing */
    }
  }
}

/** A run output line is a serialized AgentEvent; fall back to a raw event. */
function parseAgentEvent(line: string): AgentEvent {
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { type?: unknown }).type === 'string'
    ) {
      return parsed as AgentEvent;
    }
  } catch {
    /* not JSON — render verbatim as a raw event */
  }
  return { type: 'raw', line };
}

/** `2026-05-30T01-02-03` — filesystem-safe, sortable, second precision. */
function stampForFilename(d: Date): string {
  return d.toISOString().replace(/:/g, '-').replace(/\..*$/, '');
}

/** `2026-05-30 01:02:03` — readable header/line stamp (UTC). */
function formatStamp(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

/** Pretty-print a tool input; non-JSON-serialisable values degrade to String. */
function stringifyInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** Cut oversized blocks so one big read doesn't drown the transcript. */
function truncate(content: string): string {
  if (content.length <= MAX_BLOCK_CHARS) return content;
  return `${content.slice(0, MAX_BLOCK_CHARS)}\n… (truncado, ${content.length} chars)`;
}

/** `mcp__devia-kanban__kanban_list` → `MCP: devia-kanban/kanban_list`;
 *  anything else keeps the `Tool: <name>` prefix the log always used. */
function displayToolName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `MCP: ${mcp[1]}/${mcp[2]}`;
  return `Tool: ${name}`;
}

function formatUsage(u: Extract<AgentEvent, { type: 'usage' }>): string {
  const parts: string[] = [];
  if (u.inputTokens !== undefined) parts.push(`in ${u.inputTokens}`);
  if (u.outputTokens !== undefined) parts.push(`out ${u.outputTokens}`);
  if (u.cachedInputTokens !== undefined) parts.push(`cache ${u.cachedInputTokens}`);
  if (u.costUsd !== undefined) parts.push(`$${u.costUsd.toFixed(4)}`);
  if (u.contextWindow !== undefined) parts.push(`ctx ${u.contextWindow}`);
  return parts.length ? parts.join(' · ') : 'sin métricas';
}

/** Fence content in a code block, picking a backtick run longer than any inside. */
function fence(content: string, lang = ''): string {
  const longest = (content.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${content}\n${ticks}\n`;
}
