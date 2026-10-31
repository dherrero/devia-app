import type { Feature, FeatureContext } from '../../shared/feature';
import type {
  AttachmentEnricher,
  ConfigRepository,
  GitInspector,
  OutboxFlusher,
  SessionStore,
  StateStore,
} from '../../shared/ports';
import type { TechDetector } from '../workspace/domain/ports';
import type { ProcessTrackingRegistry } from './domain/ports';
import type { CliAdapterRegistry, CliLauncher } from '../cli-adapters';
import type { WorktreeRef } from '../git/domain/worktree-ref';
import type { EnsureWorktreeResult } from '../git';
import type { QueueService } from '../queue';
import type { AgentAuditLog } from '../security/audit-log';
import { NullAuditLog } from '../security/audit-log';

import { LauncherBackedAgentRunner } from './infrastructure/cli-runner-adapter';
import type { MapperRegistry } from '../agents';

import { RunInstructionUseCase } from './application/run-instruction.use-case';
import { StopProjectUseCase } from './application/stop-project.use-case';
import { StopAllUseCase } from './application/stop-all.use-case';
import { ResetSessionUseCase } from './application/reset-session.use-case';

import { registerClaudeRunnerIpc } from './ipc/claude.ipc';

export { InMemoryProjectRegistry } from './infrastructure/in-memory-project-registry';

export interface ClaudeRunnerDeps {
  config: ConfigRepository;
  sessions: SessionStore;
  state: StateStore;
  attachments: AttachmentEnricher;
  outbox: OutboxFlusher;
  tech: TechDetector;
  registry: ProcessTrackingRegistry;
  /** Catalog of CLI adapters the runner can drive. */
  agents: CliAdapterRegistry;
  /** Process launcher provided by the cli-adapters feature. */
  launcher: CliLauncher;
  /** Agent id → mapper (S-30), shared with cli-adapters for capability views. */
  mappers: MapperRegistry;
  /** Per-project instruction queue — the IPC adapter consults it before running. */
  queue: QueueService;
  /**
   * Audit log for tool_use events (TS-CLI-12 Phase 4).
   * Defaults to NullAuditLog when not provided so existing callers don't break.
   */
  auditLog?: AgentAuditLog;
  /**
   * Git inspector for fetching diff snapshots after file-editing tool results
   * (TS-CLI-10). Optional — when absent diff snapshots are silently skipped.
   */
  gitInspector?: GitInspector;
  /**
   * Synchronous per-session worktree guarantee (S-13 T-153). When present and
   * `config.worktreePerSession` is on, an additional/isolated session runs in
   * its own git worktree. Absent ⇒ no isolation (current behaviour).
   */
  ensureSessionWorktree?: (ref: WorktreeRef) => EnsureWorktreeResult;
  /**
   * Prompt pack registry (REV-AGENT-CORE-003). When absent, packs are
   * disabled and runs use the baseline system prompt only.
   */
  promptPacks?: import('../prompt-packs').PromptPackRegistry;
  /**
   * MCP server registry (REV-AGENT-CORE-004). When absent, runs proceed
   * without `--mcp-config` injection.
   */
  mcpServers?: import('../mcp').McpServerRegistry;
  /**
   * Provider for Devia's bundled kanban MCP server config (E-DSK-12). When
   * present, the Claude runner appends it to `--mcp-config` so the SDD
   * planner's `kanban_*` tools load without a project `.mcp.json` trust prompt.
   */
  kanbanMcpServer?: (projectAbs: string) => import('../../../shared/domain/mcp').McpServerConfig;
  /**
   * Provider for Devia's bundled `devia-memory` MCP server config (S-1).
   * Appended to Claude's `--mcp-config` like the kanban server when memory is
   * enabled.
   */
  memoryMcpServer?: (projectAbs: string, agentId?: string) => import('../../../shared/domain/mcp').McpServerConfig;
  /**
   * S-25: the bundled `devia-ui` server, which carries every interface tool.
   * Keyed by the PER-RUN rendezvous directory, not by project. How it reaches
   * each agent is that agent's mapper's job (S-30).
   */
  uiMcpServer?: (
    uiDir: string,
    tools: readonly import('../../../shared/domain/ui-tools').UiToolName[],
    harness?: import('../ui-tools').UiServerHarness,
  ) => import('../../../shared/domain/mcp').McpServerConfig;
  /** S-30 T-356: skills + sub-agents Devia manages; they travel with every run. */
  harnessCatalog?: import('./domain/ports').HarnessCatalog;
  /** S-25 F2.6: pushes a `devia_notify` message to the chat relay, when one is up. */
  notifyRemote?: (text: string) => void;
  /** S-25 F2.4: per-project "always allow" grants for `devia_confirm`. */
  isConfirmationGranted?: (projectAbs: string, action: string) => boolean;
  grantConfirmation?: (projectAbs: string, action: string, agentId: string) => void;
  /**
   * Provider of recent project memory summaries (E-DSK-13 phase A), newest
   * first. Threaded into RunInstructionUseCase to pre-inject memory context
   * into the system prompt.
   */
  memoryContext?: (projectAbs: string, query: string) => import('../../../shared/domain/memory').MemoryRecall;
  /**
   * Passive-capture sinks (E-DSK-13 phase C). Threaded into
   * RunInstructionUseCase to record the user prompt and an auto run summary.
   */
  saveMemoryPrompt?: (projectAbs: string, content: string, sessionId?: string, agentId?: string) => void;
  saveMemorySummary?: (projectAbs: string, content: string, sessionId?: string, startedAt?: number, agentId?: string) => void;
  /**
   * Cross-agent handoff sink (S-2 F2.2): records the handoff brief as a
   * non-auto standalone memory session entry.
   */
  saveMemoryHandoff?: (projectAbs: string, content: string, sessionId?: string, agentId?: string) => void;
  /** S-2 F2.3: synchronous read of a pre-computed handoff summary (null = miss). */
  handoffSummary?: (identity: string, sessionId: string) => string | null;
  /** S-2 F3.4: fresh rich summary the previous agent recorded via mem_session_summary. */
  recentHandoffSummary?: (projectAbs: string, sessionId: string, agentId: string, maxAgeMs: number) => string | null;
  /**
   * Cross-agent handoff notification port (S-2 F2.2 → F3.1). Forwarded to
   * RunInstructionUseCase so a run that continues another agent's session can
   * notify the renderer before its stream starts.
   */
  onSessionHandoff?: (event: {
    project: string;
    fromAgentId: string;
    toAgentId: string;
    summary: string;
    runId: import('../../../shared/domain/agent').RunId;
  }) => void;
  /**
   * Detects known third-party memory MCP servers in the project (E-DSK-13 #322)
   * for a provider-neutral coexistence warning.
   */
  detectExternalMemory?: (projectAbs: string) => string[];
  /**
   * Context-recovery sinks (E-DSK-13 Fase D). Threaded into
   * RunInstructionUseCase: `markContextCompacted` records a mid-run compaction,
   * `consumeMemoryReinjection` reports (and clears) whether the next run owes a
   * memory re-injection.
   */
  markContextCompacted?: (projectAbs: string) => void;
  consumeMemoryReinjection?: (projectAbs: string) => boolean;
  /**
   * Run gateway (E-DSK-14). When present, the IPC adapter binds its queue-aware
   * submit and republishes run events so the Telegram controller can drive and
   * mirror runs.
   */
  runGateway?: import('../../shared/run-gateway').RunGateway;
  /** Notified after a session reset (the run mode goes back to its default). */
  onSessionReset?: (project: string) => void;
  /** S-32: whether the chat relay is connected (gates `devia_send_file`). */
  remoteRelayConnected?: () => boolean;
  /** S-32: validates a live session worktree (an extra send root when it is the run cwd). */
  isLiveSessionWorktree?: (workdir: string) => boolean;
}

export function buildClaudeRunnerFeature(deps: ClaudeRunnerDeps): Feature {
  const runner = new LauncherBackedAgentRunner(deps.launcher);
  const { mappers } = deps;
  const auditLog: AgentAuditLog = deps.auditLog ?? new NullAuditLog();

  const runInstruction = new RunInstructionUseCase({
    config: deps.config,
    sessions: deps.sessions,
    state: deps.state,
    registry: deps.registry,
    runner,
    agents: deps.agents,
    attachments: deps.attachments,
    outbox: deps.outbox,
    tech: deps.tech,
    auditLog,
    ...(deps.promptPacks !== undefined && { promptPacks: deps.promptPacks }),
    ...(deps.mcpServers !== undefined && { mcpServers: deps.mcpServers }),
    ...(deps.kanbanMcpServer !== undefined && { kanbanMcpServer: deps.kanbanMcpServer }),
    ...(deps.memoryMcpServer !== undefined && { memoryMcpServer: deps.memoryMcpServer }),
    ...(deps.uiMcpServer !== undefined && { uiMcpServer: deps.uiMcpServer }),
    ...(deps.harnessCatalog !== undefined && { harnessCatalog: deps.harnessCatalog }),
    ...(deps.isConfirmationGranted !== undefined && {
      isConfirmationGranted: deps.isConfirmationGranted,
    }),
    ...(deps.grantConfirmation !== undefined && { grantConfirmation: deps.grantConfirmation }),
    ...(deps.memoryContext !== undefined && { memoryContext: deps.memoryContext }),
    ...(deps.saveMemoryPrompt !== undefined && { saveMemoryPrompt: deps.saveMemoryPrompt }),
    ...(deps.saveMemorySummary !== undefined && { saveMemorySummary: deps.saveMemorySummary }),
    ...(deps.saveMemoryHandoff !== undefined && { saveMemoryHandoff: deps.saveMemoryHandoff }),
    ...(deps.handoffSummary !== undefined && { handoffSummary: deps.handoffSummary }),
    ...(deps.recentHandoffSummary !== undefined && { recentHandoffSummary: deps.recentHandoffSummary }),
    ...(deps.onSessionHandoff !== undefined && { onSessionHandoff: deps.onSessionHandoff }),
    ...(deps.detectExternalMemory !== undefined && { detectExternalMemory: deps.detectExternalMemory }),
    ...(deps.markContextCompacted !== undefined && { markContextCompacted: deps.markContextCompacted }),
    ...(deps.consumeMemoryReinjection !== undefined && { consumeMemoryReinjection: deps.consumeMemoryReinjection }),
    ...(deps.ensureSessionWorktree !== undefined && { ensureSessionWorktree: deps.ensureSessionWorktree }),
    ...(deps.remoteRelayConnected !== undefined && { remoteRelayConnected: deps.remoteRelayConnected }),
    ...(deps.isLiveSessionWorktree !== undefined && { isLiveSessionWorktree: deps.isLiveSessionWorktree }),
    mappers,
  });
  const stopProject  = new StopProjectUseCase(deps.registry);
  const stopAll      = new StopAllUseCase(deps.registry);
  const resetSession = new ResetSessionUseCase({ registry: deps.registry, state: deps.state });

  let ipcHandle: { dispose(): void } | undefined;

  return {
    id: 'claude-runner',
    register(ctx: FeatureContext) {
      ipcHandle = registerClaudeRunnerIpc(ctx, {
        runInstruction, stopProject, stopAll, resetSession,
        attachments: deps.attachments,
        queue: deps.queue,
        registry: deps.registry,
        config: deps.config,
        auditLog,
        ...(deps.gitInspector !== undefined && { gitInspector: deps.gitInspector }),
        ...(deps.runGateway !== undefined && { runGateway: deps.runGateway }),
        ...(deps.onSessionReset !== undefined && { onSessionReset: deps.onSessionReset }),
        ...(deps.notifyRemote !== undefined && { notifyRemote: deps.notifyRemote }),
      });
    },
    onBeforeQuit() {
      ipcHandle?.dispose();
    },
  };
}
