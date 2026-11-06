import type { McpServerConfig } from '../../../../shared/domain/mcp';
import type { AgentAnswer, AgentSession, AgentSessionIo } from '../domain/agent-mapper';
import type { AgentRunPlan } from '../domain/agent-run-plan';
import { buildSystemPromptHeader } from '../shared/def-invocation';
import { answerText } from '../shared/stream-session';
import { AcpConnection, webStreamsFromChild, type AcpMcpServerSpec, type AcpPromptBlock } from './connection';
import { createEventMapState, mapPromptUsage, mapSessionUpdate, mapStopReason } from './event-map';
import { decidePermission, rejectOption, type AcpPermissionOption } from './permissions';
import type { AcpAgentProfile } from './profile';

type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

const DEFAULT_PERMISSION_TITLE = 'The agent asks permission for an action';

export interface AcpSessionOptions {
  readonly io: AgentSessionIo;
  readonly plan: AgentRunPlan;
  readonly profile: AcpAgentProfile;
  /** The composed Devia system prompt for THIS run ('' when none). */
  readonly systemPrompt: string;
  /** Servers to hand to session/new (Devia's + the user's), already filtered to the delivered ones. */
  readonly mcpServers: readonly McpServerConfig[];
  readonly now?: () => number;
  /** Time the child gets to exit after its stdin closes before SIGTERM (default 500). */
  readonly killGraceMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 500;

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
  const state = createEventMapState(now());
  const pending = new Map<string, { resolve: (outcome: PermissionOutcome) => void; options: AcpPermissionOption[] }>();
  let done = false;

  const fail = (message: string): void => {
    if (done) return;
    done = true;
    io.emit({ type: 'error', message });
    try {
      io.process.kill('SIGTERM');
    } catch {
      // the child is already gone
    }
  };

  const emitMapped = (update: unknown): void => {
    for (const event of mapSessionUpdate(update, state, { profile, serverIds }, now())) io.emit(event);
  };

  const connection = new AcpConnection(webStreamsFromChild({ stdin: io.stdin, stdout: io.stdout }), {
    onSessionUpdate: (_sessionId, update) => {
      if (!done) emitMapped(update);
    },
    onRequestPermission: (request) => requestPermission(request.toolCall, parseOptions(request.options)),
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
      profile,
    });
    if (decision.kind === 'select') return Promise.resolve({ outcome: 'selected', optionId: decision.optionId });
    if (decision.kind === 'cancel') return Promise.resolve({ outcome: 'cancelled' });

    const callId = toolCall.toolCallId;
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

  const cancelPending = (): void => {
    for (const entry of pending.values()) entry.resolve({ outcome: 'cancelled' });
    pending.clear();
  };

  const finishChild = (): void => {
    io.stdin?.end();
    const grace = setTimeout(() => {
      if (io.process.exitCode === null && !io.process.killed) {
        try {
          io.process.kill('SIGTERM');
        } catch {
          // the child is already gone
        }
      }
    }, killGraceMs);
    grace.unref();
    io.process.once('close', () => clearTimeout(grace));
  };

  const run = async (): Promise<void> => {
    const info = await connection.initialize(profile.clientCapabilities);
    if (info.authMethods.length > 0 && profile.authMethodId !== undefined) {
      await connection.authenticate(profile.authMethodId);
    }
    const { sessionId } = await connection.newSession({
      cwd: plan.cwd,
      mcpServers: options.mcpServers.map(toAcpMcpServer),
    });
    io.emit({ type: 'session_started', agentSessionId: sessionId });
    const blocks: AcpPromptBlock[] = [
      { type: 'text', text: buildSystemPromptHeader(options.systemPrompt) + plan.prompt },
    ];
    const response = await connection.prompt(sessionId, blocks);
    if (done) return;
    done = true;
    const usage = mapPromptUsage(response);
    if (usage) io.emit(usage);
    io.emit({ type: 'turn_end', stopReason: mapStopReason(response.stopReason) });
    finishChild();
  };

  io.process.once('close', () => {
    cancelPending();
    fail('ACP agent exited before completing the turn');
  });

  run().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));

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
      // Task 13
    },
  };
}
