import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type { DetectedAgent } from '../domain/runtime-agent-def';
import type { AgentHarnessView, DetectedAgentView } from '../../../../shared/domain/agent';
import type { ListAgentsUseCase } from '../application/list-agents.use-case';
import type { SelectAgentUseCase } from '../application/select-agent.use-case';
import type { SetAgentModelUseCase } from '../application/set-agent-model.use-case';
import type { SetAgentEnvUseCase } from '../application/set-agent-env.use-case';
import type { TestAgentUseCase } from '../application/test-agent.use-case';

export interface CliAdaptersIpcDeps {
  listAgents: ListAgentsUseCase;
  selectAgent: SelectAgentUseCase;
  setAgentModel: SetAgentModelUseCase;
  setAgentEnv: SetAgentEnvUseCase;
  testAgent: TestAgentUseCase;
  /** Called after a successful agent selection to invalidate the detection cache. */
  onAgentSelected?: () => void;
  /** The agent's harness capabilities (from its mapper), when known. */
  describe?: (agentId: string) => AgentHarnessView | undefined;
}

export function toView(a: DetectedAgent, harness?: AgentHarnessView): DetectedAgentView {
  const view: DetectedAgentView = {
    id: a.id,
    name: a.name,
    bin: a.bin,
    streamFormat: a.streamFormat,
    available: a.available,
    // New provider-type metadata (REV-AGENT-CORE-014): always present so the
    // renderer can label non-CLI providers without falling back to "no
    // detected" copy that misrepresents API / planned entries.
    providerType: a.providerType,
    applicability: a.applicability,
    selectable: a.selectable,
    models: a.models.map((m) => ({ id: m.id, label: m.label })),
  };
  if (a.configured !== undefined) view.configured = a.configured;
  if (a.unavailableReason) view.unavailableReason = a.unavailableReason;
  if (a.eventParser) view.eventParser = a.eventParser;
  if (a.promptViaStdin) view.promptViaStdin = a.promptViaStdin;
  if (a.promptInputFormat) view.promptInputFormat = a.promptInputFormat;
  if (a.reasoningOptions) {
    view.reasoningOptions = a.reasoningOptions.map((r) => ({ id: r.id, label: r.label }));
  }
  if (a.envOverrideKeys) view.envOverrideKeys = [...a.envOverrideKeys];
  if (a.installUrl) view.installUrl = a.installUrl;
  if (a.docsUrl) view.docsUrl = a.docsUrl;
  if (a.authStatus) view.authStatus = a.authStatus;
  if (a.authMessage) view.authMessage = a.authMessage;
  if (a.path) view.path = a.path;
  if (a.version !== undefined) view.version = a.version;
  if (harness) view.harness = { ...harness };
  return view;
}

export function registerCliAdaptersIpc(ctx: FeatureContext, deps: CliAdaptersIpcDeps): void {
  ctx.ipc.handle(IPC.agentsList, async () => {
    const detected = await deps.listAgents.execute();
    return detected.map((a) => toView(a, deps.describe?.(a.id)));
  });

  ctx.ipc.handle(IPC.agentSelect, (_e, agentId: string) => {
    const result = deps.selectAgent.execute({ agentId });
    if (result.accepted) deps.onAgentSelected?.();
    ctx.send('agent:changed', { agentId: result.agentId });
    return result;
  });

  ctx.ipc.handle(IPC.agentSetModel, (_e, input: { agentId: string; model?: string | null; reasoning?: string | null }) =>
    deps.setAgentModel.execute(input));

  ctx.ipc.handle(IPC.agentSetEnv, (_e, input: { agentId: string; env: Record<string, string> }) =>
    deps.setAgentEnv.execute(input));

  ctx.ipc.handle(IPC.agentTest, async (_e, agentId: string) => {
    const result = await deps.testAgent.execute(agentId);
    // REV-TS-CLI-13-03: map full DetectedAgent → DetectedAgentView so the
    // renderer receives authStatus, diagnostic, and resolvedBin rather than
    // the minimal TestAgentResult that previously dropped those fields.
    // If the agent ID is unknown, return a minimal "not available" view.
    if ('id' in result) return toView(result as DetectedAgent, deps.describe?.(agentId));
    // Unknown agent: return a minimal DetectedAgentView so the type contract holds.
    const msg = (result as { message?: string }).message;
    const notFound: DetectedAgentView = {
      id: agentId,
      name: agentId,
      bin: agentId,
      streamFormat: 'plain',
      models: [],
      available: false,
      providerType: 'cli',
      applicability: 'not-applicable',
      selectable: false,
      unavailableReason: `Unknown agent id "${agentId}".`,
      ...(msg !== undefined ? { authMessage: msg } : {}),
    };
    return notFound;
  });
}
