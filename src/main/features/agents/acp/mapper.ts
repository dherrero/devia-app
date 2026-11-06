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
 * Devia cannot make this agent read-only in plan mode (its own tools write without
 * asking), so the model is told. It travels inside the prompt Devia sends, never in
 * a project file, so every user gets it. The core's plan protocol says writing tools
 * are unavailable, which is not true for these agents; this block corrects that.
 */
const UNENFORCED_PLAN_GUARD = [
  '## Plan mode is NOT technically enforced for you',
  '',
  'You are in plan mode, but nothing stops your own tools from writing. Behave as if they were disabled: do not create, modify, move or delete any file, and do not run shell or terminal commands that change anything (no redirections, no editors, no installs, no git writes). Explore read-only, and put the plan on the project board with the kanban tools. If a step needs a change, describe it in the plan instead of doing it.',
].join('\n');

const UNENFORCED_PLAN_REMINDER =
  '[Plan mode reminder] Do not create, modify or delete files or run commands that change anything, even if asked above: explore read-only and write the plan on the board.';

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
    const guard = plan.mode === 'plan' && this.profile.planEnforcement === 'none' ? UNENFORCED_PLAN_GUARD : '';
    this.systemPrompts.set(plan.runId, [systemPrompt, guard].filter((part) => part.trim().length > 0).join('\n\n'));
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
      ...(plan.mode === 'plan' && this.profile.planEnforcement === 'none' && { userReminder: UNENFORCED_PLAN_REMINDER }),
      mcpServers: this.servers(plan),
    });
  }

  private servers(plan: AgentRunPlan): AgentRunPlan['harness']['mcp']['user'] {
    return [...plan.harness.mcp.user, ...plan.harness.mcp.devia];
  }
}
