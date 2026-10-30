/**
 * Minimal ACP (Agent Client Protocol) session driver for stdio JSON-RPC agents
 * (Kimi, Hermes, …). Ported from open-design's `acp.ts`, trimmed to what Devia
 * needs: drive `initialize → session/new → [session/set_model] → session/prompt`,
 * stream `session/update` notifications as AgentEvents, auto-approve
 * `session/request_permission`, and finish on the prompt response.
 *
 * The launcher spawns the child (with `streamFormat: 'acp-json-rpc'`) and hands
 * it here; this module owns the child's stdin (RPC requests) and stdout (NDJSON
 * responses/notifications) for the lifetime of the run.
 *
 * Note: ACP exposes `session/request_permission`, the bidirectional channel that
 * could route per-action approval to the chat. For now it is auto-approved
 * (matching the reference); wiring it to an inline approval card is future work.
 */
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { AgentEvent } from '../../../../../shared/domain/agent-event';

const ACP_PROTOCOL_VERSION = 1;

type JsonRpcId = string | number;
type JsonObject = Record<string, unknown>;

export interface AcpMcpServerInput {
  type?: string;
  name?: string;
  command?: string;
  args?: string[];
  env?: unknown[];
}

export interface AcpPermissionOption {
  optionId: string;
  label: string;
}

export interface AcpPermissionRequest {
  id: string;
  title: string;
  options: AcpPermissionOption[];
}

export interface AcpSessionOptions {
  child: ChildProcess;
  prompt: string;
  cwd: string;
  model?: string | null;
  imagePaths?: string[];
  mcpServers?: AcpMcpServerInput[];
  emit: (event: AgentEvent) => void;
  clientName?: string;
  clientVersion?: string;
  /**
   * When provided, `session/request_permission` is surfaced to the user (an
   * inline chat approval card) instead of being auto-approved. The chosen
   * answer arrives later via the returned handle's `answerPermission`.
   */
  onPermissionRequest?: (req: AcpPermissionRequest) => void;
}

export interface AcpSessionHandle {
  abort(): void;
  /** Deliver the user's answer (an option label or optionId) to a pending
   *  permission request surfaced via `onPermissionRequest`. */
  answerPermission(id: string, answer: string): void;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' ? (value as JsonObject) : null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'number' || typeof value === 'string';
}

function sendRpc(writable: Pick<Writable, 'write'>, id: JsonRpcId, method: string, params: unknown): void {
  writable.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
}

function sendRpcResult(writable: Pick<Writable, 'write'>, id: JsonRpcId, result: unknown): void {
  writable.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function buildPromptBlocks(prompt: string, imagePaths: string[]): Array<Record<string, string>> {
  const blocks: Array<Record<string, string>> = [{ type: 'text', text: prompt }];
  for (const imagePath of imagePaths) {
    if (typeof imagePath === 'string' && imagePath.trim().length > 0) {
      blocks.push({ type: 'resource_link', uri: imagePath });
    }
  }
  return blocks;
}

/** Pick a permission option that approves the request (kind allow_* / approve_for_session). */
export function choosePermissionOutcome(options: unknown): string | null {
  const list = Array.isArray(options) ? options : [];
  const bySession = list.find((o) => asObject(o)?.['optionId'] === 'approve_for_session');
  if (bySession) return 'approve_for_session';
  const allowAlways = list.find((o) => asObject(o)?.['kind'] === 'allow_always');
  const aaId = asObject(allowAlways)?.['optionId'];
  if (typeof aaId === 'string') return aaId;
  const allowOnce = list.find((o) => asObject(o)?.['kind'] === 'allow_once');
  const aoId = asObject(allowOnce)?.['optionId'];
  if (typeof aoId === 'string') return aoId;
  return null;
}

/** Tolerant NDJSON reader (handles the occasional pretty-printed startup frame). */
export function createJsonLineStream(onMessage: (message: unknown) => void) {
  let buffer = '';
  let pending = '';

  const tryEmit = (candidate: string): boolean => {
    try { onMessage(JSON.parse(candidate)); return true; } catch { return false; }
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (pending) {
      const candidate = `${pending}\n${trimmed}`;
      if (tryEmit(candidate)) { pending = ''; return; }
      if (candidate.length <= 128_000) { pending = candidate; return; }
      pending = '';
    }
    if (tryEmit(trimmed)) return;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) pending = trimmed;
  };

  return {
    feed(chunk: string): void {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    },
    flush(): void {
      if (buffer.trim()) handleLine(buffer);
      buffer = '';
      if (pending) { tryEmit(pending); pending = ''; }
    },
  };
}

function sessionNewParams(cwd: string, mcpServers?: AcpMcpServerInput[]): JsonObject {
  const servers = Array.isArray(mcpServers) ? mcpServers : [];
  return {
    cwd: path.resolve(cwd),
    mcpServers: servers.map((s) => ({
      type: typeof s?.type === 'string' ? s.type : 'stdio',
      name: typeof s?.name === 'string' ? s.name : '',
      command: typeof s?.command === 'string' ? s.command : '',
      args: Array.isArray(s?.args) ? s.args : [],
      env: Array.isArray(s?.env) ? s.env : [],
    })),
  };
}

export function runAcpSession(opts: AcpSessionOptions): AcpSessionHandle {
  const {
    child, prompt, cwd, model, imagePaths = [], mcpServers, emit,
    clientName = 'devia', clientVersion = 'desktop', onPermissionRequest,
  } = opts;
  const runStartedAt = Date.now();
  // Permission requests awaiting a user answer: id → { rawId, options }.
  const pendingPermissions = new Map<string, { rawId: JsonRpcId; options: AcpPermissionOption[] }>();

  if (!child.stdin || !child.stdout) {
    emit({ type: 'error', message: 'ACP child process is missing stdin/stdout streams' });
    return { abort: () => { /* nothing to abort */ }, answerPermission: () => { /* no session */ } };
  }
  const stdin = child.stdin;
  const stdout = child.stdout;

  let expectedId: JsonRpcId = 1;
  let nextId = 2;
  let promptRequestId: JsonRpcId | null = null;
  let setModelRequestId: JsonRpcId | null = null;
  let sessionId: string | null = null;
  let emittedFirstToken = false;
  let textBuffer = '';
  let finished = false;
  let aborted = false;

  const fail = (message: string): void => {
    if (finished) return;
    finished = true;
    emit({ type: 'error', message });
    if (!child.killed) { try { child.kill('SIGTERM'); } catch { /* best effort */ } }
  };

  const write = (id: JsonRpcId, method: string, params: unknown): void => {
    try { sendRpc(stdin, id, method, params); }
    catch (err) { fail(`stdin write failed: ${err instanceof Error ? err.message : String(err)}`); }
  };

  const sendPrompt = (): void => {
    promptRequestId = nextId;
    expectedId = promptRequestId;
    write(promptRequestId, 'session/prompt', { sessionId, prompt: buildPromptBlocks(prompt, imagePaths) });
    nextId += 1;
  };

  const parser = createJsonLineStream((raw) => {
    if (aborted || finished) return;
    const obj = asObject(raw);
    if (!obj) return;

    // Permission requests: surface to the user when a handler is wired,
    // otherwise auto-approve (reference behaviour).
    if (obj['method'] === 'session/request_permission') {
      if (!isJsonRpcId(obj['id'])) { fail('unhandled ACP permission request'); return; }
      const rawId = obj['id'];
      const params = asObject(obj['params']);
      const rawOptions = Array.isArray(params?.['options']) ? params['options'] : [];
      const options: AcpPermissionOption[] = rawOptions
        .map((o) => {
          const rec = asObject(o);
          const optionId = typeof rec?.['optionId'] === 'string' ? rec['optionId'] : '';
          const label = typeof rec?.['name'] === 'string' && rec['name'].length > 0 ? rec['name'] : optionId;
          return { optionId, label };
        })
        .filter((o) => o.optionId.length > 0);

      if (onPermissionRequest && options.length > 0) {
        const id = String(rawId);
        pendingPermissions.set(id, { rawId, options });
        const toolCall = asObject(params?.['toolCall']);
        const title =
          (typeof params?.['title'] === 'string' && params['title']) ||
          (typeof toolCall?.['title'] === 'string' && toolCall['title']) ||
          'El agente solicita permiso para una acción';
        onPermissionRequest({ id, title, options });
        return;
      }

      const optionId = choosePermissionOutcome(params?.['options']);
      if (optionId) {
        try { sendRpcResult(stdin, rawId, { outcome: { outcome: 'selected', optionId } }); }
        catch (err) { fail(`stdin write failed: ${err instanceof Error ? err.message : String(err)}`); }
      } else {
        fail('unhandled ACP permission request');
      }
      return;
    }

    // Streamed updates.
    if (obj['method'] === 'session/update') {
      const update = asObject(asObject(obj['params'])?.['update']);
      if (!update) return;
      if (update['sessionUpdate'] === 'agent_thought_chunk') {
        const text = asObject(update['content'])?.['text'];
        if (typeof text === 'string' && text.length > 0) emit({ type: 'thinking_delta', delta: text });
        return;
      }
      if (update['sessionUpdate'] === 'agent_message_chunk') {
        const text = asObject(update['content'])?.['text'];
        if (typeof text === 'string' && text.length > 0) {
          // Some agents send cumulative text; emit only the new suffix.
          const delta = text.startsWith(textBuffer) ? text.slice(textBuffer.length) : text;
          if (delta.length > 0) {
            textBuffer += delta;
            if (!emittedFirstToken) {
              emittedFirstToken = true;
              emit({ type: 'status', label: 'streaming', ttftMs: Date.now() - runStartedAt });
            }
            emit({ type: 'text_delta', delta });
          }
        }
        return;
      }
      return;
    }

    // RPC errors.
    const error = asObject(obj['error']);
    if (error) {
      const code = typeof error['code'] === 'number' ? error['code'] : null;
      // Recover from a model-selection failure by prompting with the default model.
      if (obj['id'] === setModelRequestId && promptRequestId === null &&
          (code === -32603 || code === -32602 || code === -32601 || code === -32002)) {
        setModelRequestId = null;
        sendPrompt();
        return;
      }
      if (code === -32603 && obj['id'] !== expectedId) return; // cleanup noise
      fail(typeof error['message'] === 'string' ? error['message'] : 'ACP json-rpc error');
      return;
    }

    const result = asObject(obj['result']);
    if (obj['id'] !== expectedId || !result) return;

    // initialize → session/new
    if (expectedId === 1) {
      expectedId = nextId;
      write(nextId, 'session/new', sessionNewParams(cwd, mcpServers));
      nextId += 1;
      return;
    }

    // session/new → optionally set model → prompt
    if (expectedId === 2) {
      sessionId = typeof result['sessionId'] === 'string' ? result['sessionId'] : null;
      if (!sessionId) { fail('invalid session/new response'); return; }
      emit({ type: 'session_started', agentSessionId: sessionId });
      if (model && model !== 'default') {
        setModelRequestId = nextId;
        expectedId = nextId;
        write(nextId, 'session/set_model', { sessionId, modelId: model });
        nextId += 1;
        return;
      }
      sendPrompt();
      return;
    }

    // session/prompt result → usage + turn_end
    if (promptRequestId !== null && obj['id'] === promptRequestId) {
      const usage = asObject(result['usage']);
      if (usage) {
        const e: AgentEvent = { type: 'usage' };
        if (typeof usage['inputTokens'] === 'number') e.inputTokens = usage['inputTokens'];
        if (typeof usage['outputTokens'] === 'number') e.outputTokens = usage['outputTokens'];
        emit(e);
      }
      emit({ type: 'turn_end', stopReason: 'completed' });
      finished = true;
      try { stdin.end(); } catch { /* best effort */ }
      const grace = setTimeout(() => { if (!child.killed) { try { child.kill('SIGTERM'); } catch { /* */ } } }, 500);
      child.once('close', () => clearTimeout(grace));
      return;
    }

    // set_model result → prompt
    if (model && model !== 'default' && obj['id'] === expectedId) {
      sendPrompt();
    }
  });

  // A multi-byte UTF-8 character can straddle two chunks.
  const decoder = new StringDecoder('utf8');
  stdout.on('data', (chunk: Buffer) => parser.feed(decoder.write(chunk)));
  child.on('close', () => {
    parser.feed(decoder.end());
    parser.flush();
    if (!finished && !aborted) fail('ACP session exited before completion');
  });
  child.on('error', (err: Error) => fail(err.message));
  stdin.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') fail(`stdin error: ${err.message}`); });

  // Kick off the handshake.
  write(1, 'initialize', {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { terminal: false },
    clientInfo: { name: clientName, version: clientVersion },
  });

  return {
    answerPermission(id: string, answer: string): void {
      const pending = pendingPermissions.get(id);
      if (!pending) return;
      pendingPermissions.delete(id);
      // Match the user's answer to an ACP option by label or optionId; if it
      // matches none (e.g. a free-form reply), cancel the request (deny).
      const chosen = pending.options.find((o) => o.label === answer || o.optionId === answer);
      try {
        const outcome = chosen
          ? { outcome: 'selected', optionId: chosen.optionId }
          : { outcome: 'cancelled' };
        sendRpcResult(stdin, pending.rawId, { outcome });
      } catch (err) {
        fail(`stdin write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    abort(): void {
      if (aborted || finished) return;
      aborted = true;
      finished = true;
      try {
        if (sessionId && stdin.writable) {
          sendRpc(stdin, nextId, 'session/cancel', { sessionId });
          nextId += 1;
        }
        stdin.end();
      } catch { /* caller owns the SIGTERM fallback */ }
    },
  };
}
