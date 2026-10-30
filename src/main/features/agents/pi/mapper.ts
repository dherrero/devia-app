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
import { retirePiProjectMcp, writePiMcpExtension } from './pi-mcp-extension';
import { openPiSession } from './session';

const UI_SERVER_ID = 'devia-ui';

/**
 * pi (S-30 T-350), verified against pi 1.3.0.
 *
 * - MCP: one per-run `-e` extension registering Devia's AND the user's
 *   MCP-manager servers (`pi.registerMcpServer`) — pi reads `.pi/mcp.json`
 *   only in trusted projects, and a file entry would override the
 *   registration, so stale Devia entries there are retired every run.
 * - Skills: native `--skill <dir>` for every skill Devia manages (explicit
 *   paths bypass project trust); sub-agents: through `devia_skill` — pi has no
 *   sub-agent concept.
 * - System prompt `--append-system-prompt <file>`, plan mode
 *   `--tools read,grep,find,ls,mcp__*`, resume `--session-id` — the def's flags.
 * - Session: the RPC driver (`rpc-driver.ts`, contract in `wire.ts`).
 * - pi cannot load "only Devia's" MCP: `--no-mcp` would drop the extension's
 *   servers too, so external-memory isolation is not offered.
 */
export class PiMapper implements AgentMapper {
  readonly id = 'pi';
  readonly harnessSupport: HarnessSupport = { mcp: 'native', skills: 'native', subagents: 'devia' };
  readonly isolatesExternalMcp = false;

  constructor(readonly def: RuntimeAgentDef, _deps: MapperDeps) {}

  disallowedTools(_mode: RunMode): readonly string[] {
    return [...(this.def.defaultDisallowedTools ?? [])];
  }

  resolveDelivery(plan: AgentRunPlan): DeliveryResolution {
    const ids = [...plan.harness.mcp.user, ...plan.harness.mcp.devia].map((s) => s.id);
    return {
      mcpServerIds: ids,
      skills: plan.harness.skills.length > 0 ? 'native' : 'none',
      subagents: ids.includes(UI_SERVER_ID) && plan.harness.subagents.length > 0 ? 'devia' : 'none',
      notices: [],
    };
  }

  prepareRun(plan: AgentRunPlan, systemPrompt: string, delivery: DeliveryResolution): PrepareResult {
    const delivered = new Set(delivery.mcpServerIds);
    const servers = [...plan.harness.mcp.user, ...plan.harness.mcp.devia].filter((s) => delivered.has(s.id));
    // A `.pi/mcp.json` entry overrides a registration with the same name.
    retirePiProjectMcp(plan.cwd);
    const extension = writePiMcpExtension(servers, plan.deviaDir, process.env);

    const flags = this.def.buildExtraArgs?.({ systemPrompt, capabilities: plan.capabilities }) ?? [];
    const resume = plan.resumeSessionId !== undefined ? this.def.buildResumeArgs?.(plan.resumeSessionId) ?? [] : [];
    const built = buildDefInvocation(this.def, plan, systemPrompt, [
      ...flags,
      ...resume,
      ...(extension ? ['-e', extension.path] : []),
      ...plan.harness.skills.flatMap((s) => ['--skill', s.dir]),
    ]);
    if (!built.ok) {
      extension?.cleanup();
      return built;
    }
    return {
      ok: true,
      run: {
        args: built.invocation.args,
        stdin: built.invocation.stdin,
        env: { ...plan.envOverrides },
        mcpServerIds: extension ? servers.map((s) => s.id) : [],
        notices: [],
        cleanup: () => {
          built.invocation.cleanup();
          extension?.cleanup();
        },
      },
    };
  }

  openSession(io: AgentSessionIo, plan: AgentRunPlan): AgentSession {
    const serverIds = [...plan.harness.mcp.user, ...plan.harness.mcp.devia].map((s) => s.id);
    return openPiSession(io, plan, serverIds);
  }
}
