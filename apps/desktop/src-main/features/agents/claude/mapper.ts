import type { RunMode } from '../../../../shared/domain/run-capabilities';
import type { RuntimeAgentDef } from '../../cli-adapters/domain/runtime-agent-def';
import type {
  AgentMapper,
  AgentRunPlan,
  AgentSession,
  AgentSessionIo,
  DeliveryResolution,
  HarnessSupport,
  PrepareResult,
} from '../domain';
import type { MapperDeps } from '../infrastructure/mapper-deps';
import { buildDefInvocation } from '../shared/def-invocation';
import { openStreamSession } from '../shared/stream-session';
import { createClaudeStreamParser } from './decoder';
import { ENTERPRISE_NOTICE, prepareClaudeMcp } from './mcp';
import { buildClaudeAgents, writeClaudeAgentsFile } from './subagents';

const UI_SERVER_ID = 'devia-ui';

/**
 * Claude Code (S-30 T-349). Everything Claude-specific that used to live in
 * the core use case and the launcher:
 *
 * - MCP: per-run `--mcp-config` (user + Devia servers), grants, `--strict`,
 *   the enterprise carve-out (T-88) — see `mcp.ts`.
 * - Sub-agents: native `--agents <file>`; skills: native `.claude/skills` plus
 *   every other Devia skill through `devia_skill`.
 * - `Workflow` dropped outside plan mode (S-16 T-189).
 * - System prompt `--append-system-prompt`, permission mode, `--disallowedTools`,
 *   `--add-dir`, `--resume` — built by the def's own flag builders.
 * - Session: its stream-json decoder (`wire.ts` is the contract) and the
 *   stream-json stdin for `tool_result`s.
 */
export class ClaudeMapper implements AgentMapper {
  readonly id = 'claude';
  readonly harnessSupport: HarnessSupport = { mcp: 'native', skills: 'devia', subagents: 'native' };
  readonly isolatesExternalMcp = true;

  constructor(readonly def: RuntimeAgentDef, private readonly deps: MapperDeps) {}

  disallowedTools(mode: RunMode): readonly string[] {
    // S-16 T-189: `Workflow`'s ~4.5k-token schema sits in the cached prefix on
    // every turn and only earns it in plan mode; `--disallowedTools` drops the
    // definition itself, not just its use.
    return [...(this.def.defaultDisallowedTools ?? []), ...(mode !== 'plan' ? ['Workflow'] : [])];
  }

  private enterprise(): boolean {
    return this.deps.enterpriseMcpConfigPresent?.() ?? false;
  }

  resolveDelivery(plan: AgentRunPlan): DeliveryResolution {
    if (this.enterprise()) {
      console.warn('[devia:run] enterprise MCP config detected — passing neither --mcp-config nor --strict-mcp-config (T-88)');
      return { mcpServerIds: [], skills: 'none', subagents: plan.harness.subagents.length > 0 ? 'native' : 'none', notices: [ENTERPRISE_NOTICE] };
    }
    const ids = [...plan.harness.mcp.user, ...plan.harness.mcp.devia].map((s) => s.id);
    return {
      mcpServerIds: ids,
      skills: ids.includes(UI_SERVER_ID) && plan.harness.skills.length > 0 ? 'devia' : 'none',
      subagents: plan.harness.subagents.length > 0 ? 'native' : 'none',
      notices: [],
    };
  }

  prepareRun(plan: AgentRunPlan, systemPrompt: string, delivery: DeliveryResolution): PrepareResult {
    const delivered = new Set(delivery.mcpServerIds);
    const servers = [...plan.harness.mcp.user, ...plan.harness.mcp.devia].filter((s) => delivered.has(s.id));
    const mcp = prepareClaudeMcp(plan, servers, this.enterprise());
    const agents = writeClaudeAgentsFile(buildClaudeAgents(plan.harness.subagents, plan.cwd), plan.deviaDir);
    const cleanup = (): void => {
      mcp.cleanup();
      agents?.cleanup();
    };

    const flags = this.def.buildExtraArgs?.({
      systemPrompt,
      capabilities: plan.capabilities,
      ...(plan.resumeSessionId !== undefined && { resumeSessionId: plan.resumeSessionId }),
    }) ?? [];
    const resume = plan.resumeSessionId !== undefined ? this.def.buildResumeArgs?.(plan.resumeSessionId) ?? [] : [];
    const built = buildDefInvocation(this.def, plan, systemPrompt, [
      ...flags,
      ...resume,
      ...mcp.args,
      ...(agents ? ['--agents', agents.path] : []),
    ]);
    if (!built.ok) {
      cleanup();
      return built;
    }
    return {
      ok: true,
      run: {
        args: built.invocation.args,
        stdin: built.invocation.stdin,
        env: { ...plan.envOverrides },
        // The `devia-ui` server inherits Claude's env: where to meet the core
        // and how long a blocking card may wait. Devia's, not the user's.
        agentEnv: {
          DEVIA_UI_DIR: plan.ui.rendezvousDir,
          DEVIA_UI_TOOL_TIMEOUT_MS: String(plan.ui.toolTimeoutMs),
        },
        mcpServerIds: mcp.mcpServerIds,
        notices: [],
        cleanup: () => {
          built.invocation.cleanup();
          cleanup();
        },
      },
    };
  }

  openSession(io: AgentSessionIo, _plan: AgentRunPlan): AgentSession {
    return openStreamSession(this.def, io, createClaudeStreamParser);
  }
}
