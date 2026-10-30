import * as os from 'node:os';

import type { AgentEvent } from '../../../../shared/domain/agent-event';
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
import { createOpencodeEventStreamParser } from './decoder';
import { buildOpencodeRunConfig, retireOpencodeProjectMcp, writeOpencodeRunConfig } from './run-config';

const UI_SERVER_ID = 'devia-ui';

/**
 * OpenCode names an MCP tool `<server>_<tool>`; Devia's canonical form is
 * `mcp__<server>__<tool>` (contract A). Only servers this run registered are
 * mapped — the longest id wins, since ids and tool names both contain `_`.
 */
export function canonicalOpencodeToolName(name: string, serverIds: readonly string[]): string {
  const match = [...serverIds].sort((a, b) => b.length - a.length).find((id) => name.startsWith(`${id}_`));
  return match ? `mcp__${match}__${name.slice(match.length + 1)}` : name;
}

/**
 * OpenCode (S-30 T-351), verified against opencode 1.19.3.
 *
 * - MCP + sub-agents: ONE per-run config passed as `OPENCODE_CONFIG` (merged
 *   with the project's/user's own) — no Devia write into the repository's
 *   `opencode.json`, so a user server's tokens never land in the repo. Stale
 *   Devia entries earlier versions wrote there are retired.
 * - Skills: OpenCode reads `.agents/skills` natively; every other Devia skill
 *   (and the sub-agents, too) through `devia_skill`.
 * - Resume: native `run --session <id>` (no transcript replay any more).
 * - System prompt `[System]…[User]` on stdin; plan `--agent plan`; apply
 *   `--dangerously-skip-permissions` — the def's own flags.
 * - Session: its `--format json` decoder (`wire.ts`), with MCP tool names
 *   made canonical.
 */
export class OpencodeMapper implements AgentMapper {
  readonly id = 'opencode';
  readonly harnessSupport: HarnessSupport = { mcp: 'native', skills: 'devia', subagents: 'native' };
  readonly isolatesExternalMcp = false;

  constructor(readonly def: RuntimeAgentDef, _deps: MapperDeps, private readonly home: () => string = os.homedir) {}

  disallowedTools(_mode: RunMode): readonly string[] {
    return [...(this.def.defaultDisallowedTools ?? [])];
  }

  resolveDelivery(plan: AgentRunPlan): DeliveryResolution {
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
    retireOpencodeProjectMcp(plan.cwd, this.home());
    const config = writeOpencodeRunConfig(buildOpencodeRunConfig(servers, plan.harness.subagents, process.env), plan.deviaDir);

    const flags = this.def.buildExtraArgs?.({ systemPrompt, capabilities: plan.capabilities }) ?? [];
    const resume = plan.resumeSessionId !== undefined ? this.def.buildResumeArgs?.(plan.resumeSessionId) ?? [] : [];
    const built = buildDefInvocation(this.def, plan, systemPrompt, [...flags, ...resume]);
    if (!built.ok) {
      config?.cleanup();
      return built;
    }
    return {
      ok: true,
      run: {
        args: built.invocation.args,
        stdin: built.invocation.stdin,
        env: { ...plan.envOverrides },
        ...(config && { agentEnv: { OPENCODE_CONFIG: config.path } }),
        mcpServerIds: config ? servers.map((s) => s.id) : [],
        notices: [],
        cleanup: () => {
          built.invocation.cleanup();
          config?.cleanup();
        },
      },
    };
  }

  openSession(io: AgentSessionIo, plan: AgentRunPlan): AgentSession {
    const serverIds = [...plan.harness.mcp.user, ...plan.harness.mcp.devia].map((s) => s.id);
    const canonical: AgentSessionIo = {
      ...io,
      emit: (event: AgentEvent) =>
        io.emit(event.type === 'tool_use' ? { ...event, name: canonicalOpencodeToolName(event.name, serverIds) } : event),
    };
    return openStreamSession(this.def, canonical, createOpencodeEventStreamParser);
  }
}
