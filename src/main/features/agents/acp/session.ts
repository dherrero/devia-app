import type { McpServerConfig } from '../../../../shared/domain/mcp';
import type { AgentSession, AgentSessionIo } from '../domain/agent-mapper';
import type { AgentRunPlan } from '../domain/agent-run-plan';
import { buildSystemPromptHeader } from '../shared/def-invocation';
import { AcpConnection, webStreamsFromChild, type AcpMcpServerSpec, type AcpPromptBlock } from './connection';
import { createEventMapState, mapPromptUsage, mapSessionUpdate, mapStopReason } from './event-map';
import type { AcpAgentProfile } from './profile';

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
    onRequestPermission: async () => ({ outcome: 'cancelled' }),
  });

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

  run().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));

  return {
    flush(): void {
      // nothing is buffered: the SDK owns the stream
    },
    answer(): boolean {
      return false;
    },
    abort(): void {
      // Task 13
    },
  };
}
