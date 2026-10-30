/**
 * Driver for pi's `--mode rpc` protocol over stdio (verified against pi 1.3.0,
 * docs `rpc.md` / `rpc-commands.md` / `json.md` / `rpc-extension-ui.md` in the
 * `@earendil-works/pi-coding-agent` package). pi's framing is its own dialect
 * (`{ id, type, ...params }`, not JSON-RPC 2.0): the launcher spawns
 * `pi --mode rpc`, this driver sends a `prompt` command and maps pi's streamed
 * events onto the shared `AgentEvent` union.
 *
 * Protocol facts the mapping depends on:
 *   - `agent_end` closes ONE low-level run; retries, overflow recovery,
 *     compaction and queued messages can still follow. Only `agent_settled`
 *     means pi will not continue, so that is where the Devia turn ends.
 *   - RPC mode emits no session header. The session id comes from `get_state`
 *     and is surfaced as `session_started` so the runner can resume natively
 *     with `--session-id` on the next turn.
 *   - MCP tools are named `mcp__<server>__<tool>` with every non `[A-Za-z0-9_]`
 *     character of the server replaced by `_` (`devia-ui` → `devia_ui`). The
 *     rest of Devia keys on the real server id, so known ids are restored.
 *   - Extension-UI dialog fields (`title`, `message`, `options`, …) are
 *     top-level on the request, not nested under `params`.
 *
 * Extension-UI requests (dialogs) are forwarded to the optional
 * `onExtensionUiRequest` callback so Devia can draw question / confirm cards
 * and route the user's answer back through `handle.answerExtensionUi()`.
 * When no callback is wired (or it returns false) the requests fall back to
 * an auto-reply so pi never blocks on a headless run. Fire-and-forget
 * notifications are consumed silently.
 */
import { StringDecoder } from 'node:string_decoder';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { AgentEvent } from '../../../../shared/domain/agent-event';
import { createJsonLineStream } from '../../cli-adapters/infrastructure/acp/acp-session';

export interface PiExtensionUiRequest {
  id: string | number;
  method: string;
  params?: JsonRecord;
  options?: unknown[];
}

export interface PiRpcSessionOptions {
  child: ChildProcess;
  prompt: string;
  model?: string | null;
  /** Images attached to the prompt; sent inline as base64 `ImageContent`. */
  imagePaths?: readonly string[];
  /**
   * MCP server ids whose sanitised form must be mapped back in tool names.
   * Defaults to Devia's bundled servers.
   */
  mcpServerIds?: readonly string[];
  emit: (event: AgentEvent) => void;
  /**
   * Called when PI sends an `extension_ui_request` (question / confirm / pick).
   * Return `true` to take ownership — the caller must later call
   * `handle.answerExtensionUi()` with the user's response. Return `false`
   * (or omit the callback) to let the default auto-reply handle it.
   */
  onExtensionUiRequest?: (req: PiExtensionUiRequest) => boolean;
}

export interface PiRpcSessionHandle {
  abort(): void;
  /** Deliver the user's answer to a pending PI extension_ui_request. */
  answerExtensionUi(id: string | number, result: JsonRecord): void;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}
function rec(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const FIRE_AND_FORGET = new Set(['setStatus', 'setWidget', 'notify', 'setTitle', 'set_editor_text']);

/** Devia's bundled MCP servers — the ones the renderer has icons/cards for. */
export const DEVIA_MCP_SERVER_IDS: readonly string[] = ['devia-ui', 'devia-kanban', 'devia-memory'];

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * `mcp__devia_ui__devia_todo` → `mcp__devia-ui__devia_todo`. Only servers in
 * `serverIds` are restored: pi's sanitisation is lossy, so an unknown server
 * keeps pi's spelling.
 */
export function normalizePiToolName(name: string, serverIds: readonly string[] = DEVIA_MCP_SERVER_IDS): string {
  if (!name.startsWith('mcp__')) return name;
  for (const id of serverIds) {
    const sanitized = id.replace(/[^A-Za-z0-9_]/g, '_');
    if (sanitized === id) continue;
    const prefix = `mcp__${sanitized}__`;
    if (name.startsWith(prefix)) return `mcp__${id}__${name.slice(prefix.length)}`;
  }
  return name;
}

export interface PiMapContext {
  startedAt: number;
  firstToken: { value: boolean };
  /** Cost of every assistant response so far — the renderer keeps the LAST usage event. */
  costUsd?: { value: number };
  /** Context window of the run model, learned from `get_state`. */
  contextWindow?: { value: number | undefined };
  mcpServerIds?: readonly string[];
}

function usageEvent(u: JsonRecord, ctx: PiMapContext): AgentEvent | null {
  const e: AgentEvent = { type: 'usage' };
  const input = num(u['input']);
  const output = num(u['output']);
  // pi reports input EXCLUDING cache (Anthropic's split), which is what the
  // context bar expects; both cache buckets occupy the context.
  const cached = (num(u['cacheRead']) ?? 0) + (num(u['cacheWrite']) ?? 0);
  if (input !== undefined) e.inputTokens = input;
  if (output !== undefined) e.outputTokens = output;
  if (input !== undefined || cached > 0) e.cachedInputTokens = cached;
  const cost = rec(u['cost']);
  const total = num(cost?.['total']) ?? num(cost?.['totalCost']);
  if (total !== undefined) {
    if (ctx.costUsd) {
      ctx.costUsd.value += total;
      e.costUsd = ctx.costUsd.value;
    } else {
      e.costUsd = total;
    }
  }
  const window = ctx.contextWindow?.value;
  if (window !== undefined) e.contextWindow = window;
  if (e.inputTokens === undefined && e.outputTokens === undefined && e.costUsd === undefined) return null;
  return e;
}

/** Maps a single pi RPC event to AgentEvents. Returns true on agent_settled. */
export function mapPiRpcEvent(raw: JsonRecord, emit: (e: AgentEvent) => void, ctx: PiMapContext): boolean {
  switch (raw['type']) {
    case 'agent_start': emit({ type: 'status', label: 'working' }); return false;
    case 'turn_start': emit({ type: 'status', label: 'thinking' }); return false;
    case 'agent_settled':
      emit({ type: 'turn_end', stopReason: raw['aborted'] === true ? 'aborted' : 'completed' });
      return true;
    case 'compaction_start': emit({ type: 'status', label: 'compacting' }); return false;
    case 'compaction_end': {
      const result = rec(raw['result']);
      if (result) {
        const preTokens = num(result['tokensBefore']);
        emit({
          type: 'context_compacted',
          trigger: raw['reason'] === 'manual' ? 'manual' : 'auto',
          ...(preTokens !== undefined && { preTokens }),
        });
      } else if (raw['aborted'] !== true && typeof raw['errorMessage'] === 'string') {
        emit({ type: 'status', label: `compaction failed: ${raw['errorMessage']}` });
      }
      return false;
    }
    case 'auto_retry_start': emit({ type: 'status', label: 'retrying' }); return false;
    case 'turn_end': {
      const message = rec(raw['message']);
      const u = rec(message?.['usage']);
      if (u) {
        const e = usageEvent(u, ctx);
        if (e) emit(e);
      }
      if (message?.['stopReason'] === 'error') {
        const m = typeof message['errorMessage'] === 'string' && message['errorMessage'].length > 0 ? message['errorMessage'] : 'Pi agent error';
        emit({ type: 'error', message: m });
      }
      return false;
    }
    case 'message_update': {
      const ev = rec(raw['assistantMessageEvent']);
      if (!ev) return false;
      if (ev['type'] === 'text_delta' && typeof ev['delta'] === 'string') {
        if (!ctx.firstToken.value) {
          ctx.firstToken.value = true;
          emit({ type: 'status', label: 'streaming', ttftMs: Date.now() - ctx.startedAt });
        }
        emit({ type: 'text_delta', delta: ev['delta'] });
      } else if (ev['type'] === 'thinking_delta' && typeof ev['delta'] === 'string') {
        emit({ type: 'thinking_delta', delta: ev['delta'] });
      } else if (ev['type'] === 'error') {
        const m = typeof ev['reason'] === 'string' && ev['reason'].length > 0 ? ev['reason']
          : typeof ev['delta'] === 'string' && ev['delta'].length > 0 ? ev['delta'] : 'Agent error';
        emit({ type: 'error', message: m });
      }
      return false;
    }
    case 'tool_execution_start': {
      const id = typeof raw['toolCallId'] === 'string' ? raw['toolCallId'] : '';
      const name = typeof raw['toolName'] === 'string' ? raw['toolName'] : '';
      if (id && name) emit({ type: 'tool_use', id, name: normalizePiToolName(name, ctx.mcpServerIds), input: raw['args'] ?? {} });
      return false;
    }
    case 'tool_execution_end': {
      const id = typeof raw['toolCallId'] === 'string' ? raw['toolCallId'] : '';
      const result = rec(raw['result']);
      const content = result?.['content'];
      const text = Array.isArray(content)
        ? content.map((c) => { const it = rec(c); return it?.['type'] === 'text' ? String(it['text'] ?? '') : JSON.stringify(c); }).join('\n')
        : typeof content === 'string' ? content : '';
      if (id) emit({ type: 'tool_result', toolUseId: id, content: text, isError: raw['isError'] === true });
      return false;
    }
    case 'extension_error': {
      const m = typeof raw['error'] === 'string' && raw['error'].length > 0 ? raw['error'] : 'Extension error';
      emit({ type: 'error', message: m });
      return false;
    }
    case 'auto_retry_end': {
      if (raw['success'] === false) {
        const m = typeof raw['finalError'] === 'string' && raw['finalError'].length > 0 ? raw['finalError'] : 'Auto-retry exhausted';
        emit({ type: 'error', message: m });
      }
      return false;
    }
    default: return false;
  }
}

/**
 * The dialog fields of an `extension_ui_request`. pi sends them top-level;
 * an explicit `params` object (older drafts of the protocol) wins when present.
 */
function extensionUiParams(raw: JsonRecord): JsonRecord | undefined {
  const nested = rec(raw['params']);
  if (nested) return nested;
  const out: JsonRecord = {};
  for (const key of ['title', 'message', 'placeholder', 'prefill', 'timeout']) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function replyExtensionUi(stdin: Pick<Writable, 'write'>, raw: JsonRecord): void {
  if (raw['id'] == null) return;
  if (typeof raw['method'] === 'string' && FIRE_AND_FORGET.has(raw['method'])) return;
  let result: JsonRecord;
  if (raw['method'] === 'confirm') {
    result = { confirmed: true };
  } else {
    const params = rec(raw['params']);
    const opts = params?.['options'] ?? raw['options'];
    if (Array.isArray(opts) && opts.length > 0) {
      const first = opts[0];
      result = typeof first === 'string' ? { value: first } : { value: rec(first)?.['label'] ?? rec(first)?.['value'] ?? '' };
    } else {
      result = { cancelled: true };
    }
  }
  stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: raw['id'], ...result })}\n`);
}

function readImages(imagePaths: readonly string[]): JsonRecord[] {
  const images: JsonRecord[] = [];
  for (const p of imagePaths) {
    const mimeType = IMAGE_MIME[path.extname(p).toLowerCase()];
    if (!mimeType) continue;
    try {
      images.push({ type: 'image', data: fs.readFileSync(p).toString('base64'), mimeType });
    } catch { /* unreadable attachment — send the prompt without it */ }
  }
  return images;
}

export function runPiRpcSession(opts: PiRpcSessionOptions): PiRpcSessionHandle {
  const { child, prompt, model, emit } = opts;
  if (!child.stdin || !child.stdout) {
    emit({ type: 'error', message: 'pi RPC child process is missing stdin/stdout streams' });
    return { abort: () => { /* nothing to abort */ }, answerExtensionUi: () => { /* nothing to answer */ } };
  }
  const stdin = child.stdin;
  const stdout = child.stdout;
  const ctx: PiMapContext = {
    startedAt: Date.now(),
    firstToken: { value: false },
    costUsd: { value: 0 },
    contextWindow: { value: undefined },
    mcpServerIds: opts.mcpServerIds ?? DEVIA_MCP_SERVER_IDS,
  };
  let finished = false;
  let nextId = 1;

  const fail = (message: string): void => {
    if (finished) return;
    finished = true;
    emit({ type: 'error', message });
    if (!child.killed) { try { child.kill('SIGTERM'); } catch { /* best effort */ } }
  };

  const send = (type: string, params: JsonRecord = {}): number => {
    const id = nextId++;
    try { stdin.write(`${JSON.stringify({ id, type, ...params })}\n`); }
    catch (err) { fail(`stdin write failed: ${err instanceof Error ? err.message : String(err)}`); }
    return id;
  };

  emit({ type: 'status', label: 'initializing', ...(typeof model === 'string' && model && model !== 'default' ? { model } : {}) });
  stdin.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') fail(`stdin error: ${err.message}`); });

  const images = readImages(opts.imagePaths ?? []);
  const promptId = send('prompt', { message: prompt, ...(images.length > 0 && { images }) });
  const stateId = send('get_state');

  const parser = createJsonLineStream((raw) => {
    if (finished || !isRecord(raw)) return;
    if (raw['type'] === 'extension_ui_request') {
      const params = extensionUiParams(raw);
      const rawId = raw['id'];
      const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : '';
      const req: PiExtensionUiRequest = {
        id,
        method: typeof raw['method'] === 'string' ? raw['method'] : '',
        ...(params && { params }),
        ...(Array.isArray(raw['options']) && { options: raw['options'] }),
      };
      if (typeof raw['method'] === 'string' && FIRE_AND_FORGET.has(raw['method'])) return;
      if (opts.onExtensionUiRequest?.(req)) {
        // Caller owns the response — they must call handle.answerExtensionUi().
        return;
      }
      replyExtensionUi(stdin, raw);
      return;
    }
    if (raw['type'] === 'response') {
      if (raw['id'] === promptId && raw['success'] === false) {
        fail(`prompt rejected: ${String(raw['error'] ?? 'unknown')}`);
      } else if (raw['id'] === stateId && raw['success'] === true) {
        const data = rec(raw['data']);
        const sessionId = data?.['sessionId'];
        if (typeof sessionId === 'string' && sessionId.length > 0) {
          emit({ type: 'session_started', agentSessionId: sessionId });
        }
        const runModel = rec(data?.['model']);
        const window = num(runModel?.['contextWindow']);
        if (window !== undefined && ctx.contextWindow) ctx.contextWindow.value = window;
        const modelId = runModel?.['id'];
        if (typeof modelId === 'string' && modelId.length > 0) {
          const provider = runModel?.['provider'];
          emit({ type: 'status', label: 'model', model: typeof provider === 'string' ? `${provider}/${modelId}` : modelId });
        }
      }
      return;
    }
    const done = mapPiRpcEvent(raw, emit, ctx);
    if (done) {
      finished = true;
      // Closing stdin asks pi for an orderly shutdown; SIGTERM is the fallback.
      try { stdin.end(); } catch { /* best effort */ }
      const grace = setTimeout(() => { if (!child.killed) { try { child.kill('SIGTERM'); } catch { /* */ } } }, 1000);
      child.once('close', () => clearTimeout(grace));
    }
  });

  // A multi-byte UTF-8 character can straddle two chunks.
  const decoder = new StringDecoder('utf8');
  stdout.on('data', (chunk: Buffer) => parser.feed(decoder.write(chunk)));
  stdout.on('close', () => { parser.feed(decoder.end()); parser.flush(); });
  child.on('close', () => { parser.flush(); if (!finished) fail('pi RPC session exited before completion'); });
  child.on('error', (err: Error) => fail(err.message));

  return {
    abort(): void {
      if (finished || child.killed) return;
      finished = true;
      try { send('abort'); } catch { /* caller owns SIGTERM fallback */ }
    },
    answerExtensionUi(id: string | number, result: JsonRecord): void {
      if (finished || child.killed) return;
      try {
        stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id, ...result })}\n`);
      } catch { /* best effort */ }
    },
  };
}
