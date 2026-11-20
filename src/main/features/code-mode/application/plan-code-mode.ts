import type { McpServerConfig } from '../../../../shared/domain/mcp';
import type { RunMode } from '../../../../shared/domain/run-capabilities';
import { partitionMcpServers } from '../domain/partition';
import { CODE_MODE_SERVER_ID, type CodeModeMcpInjector } from '../mcp-server/code-mode-mcp-injector';

/**
 * Agents that can be handed the gateway: the ones Devia's other bundled servers
 * already reach through the generic MCP delivery. `pi` is out on purpose: it has
 * its own native code mode (`exposure: 'codemode'` is its default).
 */
const CODE_MODE_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini', 'opencode', 'cursor-agent', 'copilot', 'qwen']);

/** Devia's own servers depend on the turn's context: they never go behind a script. */
const DEVIA_SERVER_IDS: readonly string[] = ['devia-memory', 'devia-kanban', 'devia-ui', 'devia-code-graph', CODE_MODE_SERVER_ID];

export interface CodeModePlan {
  /** The user's servers that stay direct, in their original order. */
  user: McpServerConfig[];
  /** The `devia-code-mode` server to add to the run's Devia servers. */
  gateway: McpServerConfig;
  /** Ids of the servers now reachable only through scripts. */
  serverIds: string[];
}

export interface PlanCodeModeArgs {
  userServers: readonly McpServerConfig[];
  agentId: string;
  mode: RunMode;
  runId: string;
  injector: Pick<CodeModeMcpInjector, 'serverConfig'>;
}

/**
 * Decides, per run, whether some of the user's MCP servers go behind the gateway.
 * Returns null whenever nothing changes, so a run without code-mode servers (or
 * for an agent that cannot take the gateway) is byte-identical to before S-50.
 */
export function planCodeMode(args: PlanCodeModeArgs): CodeModePlan | null {
  if (!CODE_MODE_AGENTS.has(args.agentId)) return null;
  const { direct, codeMode } = partitionMcpServers(args.userServers, { excludeIds: DEVIA_SERVER_IDS });
  if (codeMode.length === 0) return null;
  const gateway = args.injector.serverConfig({
    codeModeServers: codeMode,
    agentId: args.agentId,
    mode: args.mode,
    runId: args.runId,
  });
  return { user: direct, gateway, serverIds: codeMode.map((s) => s.id) };
}
