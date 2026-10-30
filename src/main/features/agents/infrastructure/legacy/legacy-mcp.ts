import type { AgentRunPlan, DeliveryResolution } from '../../domain';
import type { MapperDeps } from '../mapper-deps';

const UI_SERVER_ID = 'devia-ui';


/**
 * How an agent without a dedicated mapper receives MCP servers — the
 * strategies the old `RunInstructionUseCase` switched on by agent id (S-30
 * T-347). Each dedicated mapper takes its own strategy over (Claude T-349,
 * pi T-350, OpenCode T-351).
 *
 * - `native-config`   the CLI's own project config file, written once per run.
 * - `none`            the CLI has no MCP support.
 */
export type McpStrategy = 'native-config' | 'none';

/** Agents whose CLI reads MCP servers from a project config Devia can write. */
const NATIVE_CONFIG_AGENTS = new Set(['codex', 'gemini', 'cursor-agent', 'copilot', 'qwen', 'grok']);

export function mcpStrategyFor(agentId: string): McpStrategy {
  if (NATIVE_CONFIG_AGENTS.has(agentId)) return 'native-config';
  return 'none';
}

export type LegacyMcpDeps = MapperDeps;

/**
 * Phase 1. For a native-config agent the delivery IS the config write — its
 * success is what decides whether the tools reach the agent — so it happens
 * here, before the prompt is composed (S-25).
 */
export function resolveLegacyMcpDelivery(
  agentId: string,
  agentName: string,
  plan: AgentRunPlan,
  deps: LegacyMcpDeps,
): DeliveryResolution {
  const { devia, user } = plan.harness.mcp;
  // Skills and sub-agents ride `devia_skill`, so they arrive wherever the
  // devia-ui server does (T-356); dedicated mappers add native channels.
  const harness = (delivered: readonly string[]): Pick<DeliveryResolution, 'skills' | 'subagents'> => {
    const viaDevia = delivered.includes(UI_SERVER_ID);
    return {
      skills: viaDevia && plan.harness.skills.length > 0 ? 'devia' : 'none',
      subagents: viaDevia && plan.harness.subagents.length > 0 ? 'devia' : 'none',
    };
  };
  const resolved = (mcpServerIds: string[], notices: string[] = []): DeliveryResolution =>
    ({ mcpServerIds, ...harness(mcpServerIds), notices });
  switch (mcpStrategyFor(agentId)) {
    case 'native-config': {
      const delivered = deps.nativeMcp.deliver(agentId, plan.cwd, devia);
      return resolved([...delivered.deliveredServerIds]);
    }
    case 'none': {
      // UC-FIX-005: the user configured servers this agent cannot load.
      const notices = user.length > 0 ? [`MCP servers configured but not supported by ${agentName}; ignored for this run.`] : [];
      notices.forEach((n) => console.warn(`[devia:run] ${n}`));
      return resolved([], notices);
    }
  }
}

export interface PreparedMcp {
  readonly args: string[];
  /** Server ids actually materialised (a failed temp write drops them all). */
  readonly mcpServerIds: readonly string[];
  cleanup(): void;
}

const NONE: PreparedMcp = { args: [], mcpServerIds: [], cleanup: () => undefined };

/** Phase 2: the per-run artifacts of the strategies that have them. */
export function prepareLegacyMcp(agentId: string, delivery: DeliveryResolution): PreparedMcp {
  const delivered = new Set(delivery.mcpServerIds);
  switch (mcpStrategyFor(agentId)) {
    case 'native-config':
      return { ...NONE, mcpServerIds: [...delivered] };
    case 'none':
      return NONE;
  }
}
