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
import type { AcpAgentProfile } from './profile';
import { openAcpSession } from './session';

const UI_SERVER_ID = 'devia-ui';

/**
 * One mapper for every ACP agent (S-41): the profile carries what differs per
 * agent (argv, continuity, plan enforcement, tool naming). The harness travels
 * through `session/new` — nothing is written to disk, so a user server's tokens
 * never reach the repository.
 */
export class AcpMapper implements AgentMapper {
  readonly id: string;
  readonly harnessSupport: HarnessSupport = { mcp: 'native', skills: 'devia', subagents: 'devia' };
  readonly isolatesExternalMcp = false;
  readonly freezesSystemPrompt = false;
  private readonly systemPrompts = new Map<string, string>();

  constructor(
    readonly def: RuntimeAgentDef,
    private readonly profile: AcpAgentProfile,
    readonly deps: MapperDeps,
  ) {
    this.id = def.id;
  }

  disallowedTools(): readonly string[] {
    return [...(this.def.defaultDisallowedTools ?? [])];
  }

  resolveDelivery(plan: AgentRunPlan): DeliveryResolution {
    const ids = this.servers(plan).map((s) => s.id);
    const viaUi = ids.includes(UI_SERVER_ID);
    const notices =
      plan.mode === 'plan' && this.profile.planEnforcement === 'none'
        ? [`Plan mode is not enforced by ${this.def.name}: it may still modify files.`]
        : [];
    return {
      mcpServerIds: ids,
      skills: viaUi && plan.harness.skills.length > 0 ? 'devia' : 'none',
      subagents: viaUi && plan.harness.subagents.length > 0 ? 'devia' : 'none',
      notices,
    };
  }

  prepareRun(plan: AgentRunPlan, systemPrompt: string, delivery: DeliveryResolution): PrepareResult {
    this.systemPrompts.set(plan.runId, systemPrompt);
    return {
      ok: true,
      run: {
        args: [...this.profile.args({ model: plan.model ?? null })],
        stdin: { kind: 'session' },
        env: { ...plan.envOverrides },
        mcpServerIds: [...delivery.mcpServerIds],
        notices: [],
        cleanup: () => {
          this.systemPrompts.delete(plan.runId);
        },
      },
    };
  }

  openSession(io: AgentSessionIo, plan: AgentRunPlan): AgentSession {
    return openAcpSession({
      io,
      plan,
      profile: this.profile,
      systemPrompt: this.systemPrompts.get(plan.runId) ?? '',
      mcpServers: this.servers(plan),
    });
  }

  private servers(plan: AgentRunPlan): AgentRunPlan['harness']['mcp']['user'] {
    return [...plan.harness.mcp.user, ...plan.harness.mcp.devia];
  }
}
