import type { CliAdapterRegistry, CliLauncher, RuntimeAgentDef } from '../../cli-adapters';
import type { ConfigRepository } from '../../../shared/ports';
import type { AgentSession, AgentSessionIo, PreparedRun } from '../../agents/domain';
import type { AgentProcessHandle, AgentRunHandlers } from '../domain/ports';

/**
 * One run as the core hands it to the runner: the agent's mapper has already
 * prepared argv / stdin / env and knows how to open its session (S-30
 * contract B). The runner only spawns and relays.
 */
export interface AgentRunRequest {
  def: RuntimeAgentDef;
  cwd: string;
  prepared: PreparedRun;
  openSession(io: AgentSessionIo): AgentSession;
  /** Run mode forwarded to the logger for display. */
  mode?: string;
  /** Run id forwarded to the logger so console lines are correlatable. */
  runId?: string;
}

export interface AgentRunner {
  run(req: AgentRunRequest, handlers: AgentRunHandlers): AgentProcessHandle;
}

/** `AgentRunner` over the cli-adapters launcher. */
export class LauncherBackedAgentRunner implements AgentRunner {
  constructor(private readonly launcher: CliLauncher) {}

  run(req: AgentRunRequest, handlers: AgentRunHandlers): AgentProcessHandle {
    return this.launcher.launch(
      {
        def: req.def,
        cwd: req.cwd,
        prepared: req.prepared,
        openSession: req.openSession,
        ...(req.mode !== undefined && { mode: req.mode }),
        ...(req.runId !== undefined && { runId: req.runId }),
      },
      {
        onOutput: handlers.onOutput,
        onDone: handlers.onDone,
        onError: handlers.onError,
        onUiRequest: handlers.onUiRequest,
      },
    );
  }
}

/**
 * Resolve the currently-selected agent def. Falls back to the catalog's
 * first selectable CLI entry if the persisted id is unknown (e.g. user
 * downgraded Devia and lost the catalog entry) or points at a
 * non-executable provider (api / mcp / local-model / planned — those
 * live in the registry for UI visibility only).
 *
 * REV-AGENT-CORE-014: the SelectAgentUseCase blocks persisting a non-CLI
 * id, but a stale config file or a future provider type change could
 * still leave one in `config.agentId`, so we guard here too.
 */
export function resolveCurrentAgent(
  registry: CliAdapterRegistry,
  config: ConfigRepository,
): RuntimeAgentDef {
  const cfg = config.get();
  const fromConfig = registry.get(cfg.agentId);
  if (fromConfig && (fromConfig.providerType ?? 'cli') === 'cli') return fromConfig;
  const cliFallback = registry.all().find((d) => (d.providerType ?? 'cli') === 'cli');
  if (cliFallback) return cliFallback;
  const fallback = registry.all()[0];
  if (!fallback) throw new Error('cli-adapters registry is empty');
  return fallback;
}
