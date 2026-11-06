import type { AgentEvent } from '../../../../shared/domain/agent-event';
import type { McpServerConfig } from '../../../../shared/domain/mcp';
import type { AgentAnswer, AgentSession, AgentSessionIo } from '../domain/agent-mapper';
import type { AgentRunPlan } from '../domain/agent-run-plan';
import { buildSystemPromptHeader } from '../shared/def-invocation';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { answerText } from '../shared/stream-session';
import { AcpConnection, webStreamsFromChild, type AcpMcpServerSpec, type AcpPromptBlock } from './connection';
import { createEventMapState, mapPromptUsage, mapSessionUpdate, mapStopReason } from './event-map';
import { decidePermission, rejectOption, type AcpPermissionOption } from './permissions';
import type { AcpAgentProfile } from './profile';

type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MODEL_UNSUPPORTED_STATUS = 'Model selection is not supported by the agent; using its default';
const EXITED_MESSAGE = 'ACP session exited before completion';
const DEFAULT_PERMISSION_TITLE = 'The agent asks permission for an action';

export interface AcpSessionOptions {
  readonly io: AgentSessionIo;
  readonly plan: AgentRunPlan;
  readonly profile: AcpAgentProfile;
  /** The composed Devia system prompt for THIS run ('' when none). */
  readonly systemPrompt: string;
  /** Servers to hand to session/new (Devia's + the user's), already filtered to the delivered ones. */
  readonly mcpServers: readonly McpServerConfig[];
  /** Closing reminder appended to the user text (models weigh the last instruction most). */
  readonly userReminder?: string;
  readonly now?: () => number;
  /** Time the child gets to exit after its stdin closes before SIGTERM (default 500). */
  readonly killGraceMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 500;

interface ModeState {
  readonly availableModes?: readonly { readonly id: string }[];
}

async function imageBlock(file: string, canEmbed: boolean): Promise<AcpPromptBlock> {
  const absolute = path.resolve(file);
  const link: AcpPromptBlock = { type: 'resource_link', uri: pathToFileURL(absolute).href, name: path.basename(absolute) };
  const mimeType = IMAGE_MIME[path.extname(absolute).toLowerCase()];
  if (!canEmbed || mimeType === undefined) return link;
  try {
    return { type: 'image', mimeType, data: (await readFile(absolute)).toString('base64') };
  } catch {
    return link;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function parseOptions(raw: readonly unknown[]): AcpPermissionOption[] {
  const out: AcpPermissionOption[] = [];
  for (const o of raw) {
    if (!isRecord(o) || typeof o['optionId'] !== 'string' || o['optionId'].length === 0) continue;
    out.push({
      optionId: o['optionId'],
      name: typeof o['name'] === 'string' && o['name'].length > 0 ? o['name'] : o['optionId'],
      kind: typeof o['kind'] === 'string' ? o['kind'] : 'allow_once',
    });
  }
  return out;
}

export function toAcpMcpServer(server: McpServerConfig): AcpMcpServerSpec {
  return {
    name: server.id,
    command: server.command,
    args: server.args,
    env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
  };
}

export function openAcpSession(options: AcpSessionOptions): AgentSession {
  const { io, plan, profile } = options;
  const now = options.now ?? Date.now;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const serverIds = options.mcpServers.map((s) => s.id);
  const deviaServerIds = plan.harness.mcp.devia.map((s) => s.id);
  let permissionSeq = 0;
  const state = createEventMapState(now());
  const pending = new Map<string, { resolve: (outcome: PermissionOutcome) => void; options: AcpPermissionOption[] }>();
  let finished = false;
  let aborted = false;
  let replaying = false;
  let sessionId: string | undefined;

  const killChild = (): void => {
    try {
      io.process.kill('SIGTERM');
    } catch {
      // the child is already gone
    }
  };

  const cancelPending = (): void => {
    for (const entry of pending.values()) entry.resolve({ outcome: 'cancelled' });
    pending.clear();
  };

  // The single exit of a run: whatever ends it, nothing is emitted afterwards.
  const finish = (end: { kind: 'turn_end'; event: AgentEvent[] } | { kind: 'error'; message: string }): void => {
    if (finished) return;
    finished = true;
    cancelPending();
    if (end.kind === 'turn_end') {
      for (const event of end.event) io.emit(event);
      return;
    }
    // After an abort the launcher already knows why the run ended.
    if (aborted) return;
    io.emit({ type: 'error', message: end.message });
    killChild();
  };

  const connection = new AcpConnection(webStreamsFromChild({ stdin: io.stdin, stdout: io.stdout }), {
    onSessionUpdate: (_sessionId, update) => {
      if (finished || replaying) return;
      for (const event of mapSessionUpdate(update, state, { profile, serverIds }, now())) io.emit(event);
    },
    onRequestPermission: (request) =>
      finished || aborted
        ? Promise.resolve({ outcome: 'cancelled' })
        : requestPermission(request.toolCall, parseOptions(request.options)),
  });

  function requestPermission(rawToolCall: unknown, options: AcpPermissionOption[]): Promise<PermissionOutcome> {
    const call = isRecord(rawToolCall) ? rawToolCall : {};
    const toolCall = {
      toolCallId: typeof call['toolCallId'] === 'string' ? call['toolCallId'] : 'permission',
      title: typeof call['title'] === 'string' ? call['title'] : null,
      kind: typeof call['kind'] === 'string' ? call['kind'] : null,
      rawInput: call['rawInput'],
      _meta: call['_meta'],
    };
    const decision = decidePermission({
      toolCall,
      options,
      mode: plan.mode,
      isRemote: plan.isRemote,
      serverIds,
      deviaServerIds,
      profile,
    });
    if (decision.kind === 'select') return Promise.resolve({ outcome: 'selected', optionId: decision.optionId });
    if (decision.kind === 'cancel') return Promise.resolve({ outcome: 'cancelled' });

    // Not the toolCallId: the core already saw it as a tool_use and would swallow a card keyed by it.
    const callId = `acp-permission:${toolCall.toolCallId}:${++permissionSeq}`;
    return new Promise<PermissionOutcome>((resolve) => {
      pending.set(callId, { resolve, options });
      const drawn = io.requestUi({
        callId,
        kind: 'select',
        purpose: 'permission',
        title: toolCall.title ?? DEFAULT_PERMISSION_TITLE,
        options: options.map((o) => ({ id: o.optionId, label: o.name })),
      });
      if (!drawn) {
        pending.delete(callId);
        const reject = rejectOption(options);
        resolve(reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' });
      }
    });
  }

  const endChildInput = (): void => {
    io.stdin?.end();
    const grace = setTimeout(() => {
      if (io.process.exitCode === null && !io.process.killed) killChild();
    }, killGraceMs);
    grace.unref();
    io.process.once('close', () => clearTimeout(grace));
  };

  // Replay-continuity profiles never load: the use case already folded the conversation into the prompt.
  const resumeOrCreate = async (
    capabilities: Readonly<Record<string, unknown>>,
    mcpServers: AcpMcpServerSpec[],
  ): Promise<{ sessionId: string; modes: ModeState | null | undefined }> => {
    const resumeId = plan.resumeSessionId;
    if (resumeId !== undefined && profile.continuity === 'native') {
      if (capabilities['loadSession'] === true) {
        replaying = true;
        try {
          const loaded = await connection.loadSession({ sessionId: resumeId, cwd: plan.cwd, mcpServers });
          return { sessionId: resumeId, modes: loaded.modes };
        } catch {
          io.emit({ type: 'status', label: 'Previous session not found; starting a new one' });
        } finally {
          replaying = false;
        }
      } else {
        io.emit({ type: 'status', label: 'The agent cannot resume sessions; conversation context is not carried over' });
      }
    }
    const created = await connection.newSession({ cwd: plan.cwd, mcpServers });
    return { sessionId: created.sessionId, modes: created.modes };
  };

  const applyModeAndModel = async (id: string, modes: ModeState | null | undefined): Promise<void> => {
    const modeId = profile.modeIds?.[plan.mode];
    if (modeId !== undefined && modes?.availableModes?.some((m) => m.id === modeId)) {
      await connection.setMode(id, modeId);
    }
    if (plan.model && plan.model !== 'default') {
      const applied = await connection.setModel(id, plan.model).catch(() => false);
      if (!applied) io.emit({ type: 'status', label: MODEL_UNSUPPORTED_STATUS });
    }
  };

  const run = async (): Promise<void> => {
    const info = await connection.initialize(profile.clientCapabilities);
    if (info.authMethods.length > 0 && profile.authMethodId !== undefined) {
      await connection.authenticate(profile.authMethodId);
    }
    const mcpServers = options.mcpServers.map(toAcpMcpServer);
    const { sessionId: active, modes } = await resumeOrCreate(info.capabilities, mcpServers);
    if (aborted) return;
    sessionId = active;
    io.emit({ type: 'session_started', agentSessionId: active });
    await applyModeAndModel(active, modes);
    const canEmbedImages = isRecord(info.capabilities['promptCapabilities'])
      ? info.capabilities['promptCapabilities']['image'] === true
      : false;
    const blocks: AcpPromptBlock[] = [
      {
        type: 'text',
        text:
          buildSystemPromptHeader(options.systemPrompt) +
          plan.prompt +
          (options.userReminder ? `\n\n${options.userReminder}` : ''),
      },
      ...(await Promise.all(plan.imagePaths.map((file) => imageBlock(file, canEmbedImages)))),
    ];
    const response = await connection.prompt(active, blocks);
    const events: AgentEvent[] = [];
    const usage = mapPromptUsage(response);
    if (usage) events.push(usage);
    events.push({ type: 'turn_end', stopReason: mapStopReason(response.stopReason) });
    finish({ kind: 'turn_end', event: events });
    endChildInput();
  };

  io.process.once('close', () => finish({ kind: 'error', message: EXITED_MESSAGE }));
  void connection.closed.then(() => finish({ kind: 'error', message: EXITED_MESSAGE }));

  run().catch((err: unknown) => {
    const closed = connection.raw.signal.aborted;
    finish({ kind: 'error', message: closed ? EXITED_MESSAGE : err instanceof Error ? err.message : String(err) });
  });

  return {
    flush(): void {
      // nothing is buffered: the SDK owns the stream
    },
    answer(callId: string, answer: AgentAnswer): boolean {
      const entry = pending.get(callId);
      if (!entry) return false;
      pending.delete(callId);
      if (answer.kind === 'cancel') {
        entry.resolve({ outcome: 'cancelled' });
        return true;
      }
      const text = answerText(answer);
      const chosen = entry.options.find((o) => o.optionId === text || o.name === text);
      entry.resolve(chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' });
      return true;
    },
    abort(): void {
      if (aborted) return;
      aborted = true;
      cancelPending();
      const done = sessionId === undefined ? Promise.resolve() : connection.cancel(sessionId);
      void done.finally(() => io.stdin?.end());
    },
  };
}
