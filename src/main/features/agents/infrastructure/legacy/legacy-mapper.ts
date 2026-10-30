import type { RunMode } from '../../../../../shared/domain/run-capabilities';
import type { RuntimeAgentDef } from '../../../cli-adapters/domain/runtime-agent-def';
import type {
  AgentMapper,
  AgentRunPlan,
  AgentSession,
  AgentSessionIo,
  DeliveryResolution,
  HarnessSupport,
  PrepareResult,
} from '../../domain';
import { buildDefInvocation } from '../../shared/def-invocation';
import {
  mcpStrategyFor,
  prepareLegacyMcp,
  resolveLegacyMcpDelivery,
} from './legacy-mcp';
import { openLegacySession } from './legacy-session';
import type { MapperDeps } from '../mapper-deps';


/**
 * `AgentMapper` over an existing `RuntimeAgentDef` — exactly the behaviour the
 * use case and launcher had before S-30, moved behind the port. Every agent
 * without a dedicated mapper runs through it; each dedicated mapper (Claude
 * T-349, pi T-350, OpenCode T-351) takes its agent's branches over, and the
 * remaining agents migrate in a later phase.
 */
export class LegacyMapper implements AgentMapper {
  readonly id: string;
  readonly harnessSupport: HarnessSupport;
  readonly isolatesExternalMcp: boolean;

  constructor(readonly def: RuntimeAgentDef, private readonly deps: MapperDeps) {
    this.id = def.id;
    const hasMcp = mcpStrategyFor(def.id) !== 'none';
    // Skills and sub-agents ride `devia_skill`, so they reach whoever gets MCP.
    this.harnessSupport = {
      mcp: hasMcp ? 'native' : 'none',
      skills: hasMcp ? 'devia' : 'none',
      subagents: hasMcp ? 'devia' : 'none',
    };
    this.isolatesExternalMcp = false;
  }

  disallowedTools(_mode: RunMode): readonly string[] {
    return [...(this.def.defaultDisallowedTools ?? [])];
  }

  resolveDelivery(plan: AgentRunPlan): DeliveryResolution {
    return resolveLegacyMcpDelivery(this.def.id, this.def.name, plan, this.deps);
  }

  prepareRun(plan: AgentRunPlan, systemPrompt: string, delivery: DeliveryResolution): PrepareResult {
    const mcp = prepareLegacyMcp(this.def.id, delivery);
    if (this.def.id === 'codex') this.deps.ensureCodexTrust?.(plan.cwd);
    const extraArgs = this.def.buildExtraArgs?.({
      systemPrompt,
      capabilities: plan.capabilities,
      ...(plan.resumeSessionId !== undefined && { resumeSessionId: plan.resumeSessionId }),
    }) ?? [];
    const resumeArgs =
      plan.resumeSessionId !== undefined && this.def.buildResumeArgs ? this.def.buildResumeArgs(plan.resumeSessionId) : [];
    const built = buildDefInvocation(this.def, plan, systemPrompt, [...extraArgs, ...resumeArgs, ...mcp.args]);
    if (!built.ok) {
      mcp.cleanup();
      return built;
    }
    const { invocation } = built;
    return {
      ok: true,
      run: {
        args: invocation.args,
        stdin: invocation.stdin,
        env: { ...plan.envOverrides },
        mcpServerIds: mcp.mcpServerIds,
        notices: [],
        cleanup: () => {
          invocation.cleanup();
          mcp.cleanup();
        },
      },
    };
  }

  openSession(io: AgentSessionIo, plan: AgentRunPlan): AgentSession {
    return openLegacySession(this.def, io, plan);
  }
}
