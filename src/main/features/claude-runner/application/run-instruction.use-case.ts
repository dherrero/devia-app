import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentRunHandlers, HarnessCatalog, ProcessHandle, ProcessTrackingRegistry } from '../domain/ports';
import type {
  AttachmentEnricher,
  ConfigRepository,
  OutboxFlusher,
  SessionStore,
  StateStore,
} from '../../../shared/ports';
import type { TechDetector } from '../../workspace/domain/ports';
import type { AttachmentPayload, OutboxFile, SavedAttachment } from '../../../../shared/domain/attachment';
import type { CliAdapterRegistry } from '../../cli-adapters';
import type { AgentRunner } from '../infrastructure/cli-runner-adapter';
import { resolveCurrentAgent } from '../infrastructure/cli-runner-adapter';
import { buildSystemPrompt } from '../infrastructure/system-prompt';
import { buildMemoryProtocolHint } from '../infrastructure/memory-protocol';
import { buildRemoteProtocolHint } from '../infrastructure/remote-protocol';
import { buildUiFallbackHint } from '../infrastructure/ui-tools-protocol';
import { buildWorktreeProtocolHint } from '../infrastructure/worktree-protocol';
import { buildPlanProtocolHint } from '../infrastructure/plan-protocol';
import { buildMemoryContextHint } from '../infrastructure/memory-context-hint';
import { sanitizeForMemory, buildRunSummary } from '../infrastructure/memory-capture';
import { resolveAndValidateCwd, findEscapingImagePath } from '../../cli-adapters/infrastructure/resolve-cwd';
import { isPathContained } from '../../../shared/workspace-paths';
import { worktreeRefFor } from '../../git/domain/worktree-ref';
import type { EnsureWorktreeResult } from '../../git/infrastructure/cli-git-worktree-manager';
import type { WorktreeRef } from '../../git/domain/worktree-ref';
import type { AgentEvent, CancelReason, ErrorClassification } from '../../../../shared/domain/agent-event';
import type { QuestionOption, QuestionPrompt } from '../../../../shared/contracts/events';
import type { ClassifiedError } from '../../../../shared/domain/cli-errors';
import type { RunId } from '../../../../shared/domain/agent';
import type { AgentAuditLog } from '../../security/audit-log';
import { buildDefaultCapabilities, sanitiseToolNames, type RunMode } from '../../../../shared/domain/run-capabilities';
import type { PromptPackRegistry } from '../../prompt-packs/domain/registry';
import { composeSystemPrompt } from '../../prompt-packs/application/compose-system-prompt';
import { buildSkillRegistryHint } from '../../../shared/skill-registry-hint';
import { ASK_USER_QUESTION_TOOL, RunInteraction } from './run-interaction';
import { UI_SERVER_ID, type UiServerHarness } from '../../ui-tools';
import { uiRunDir } from '../../../shared/ui-rendezvous';
import type { UiToolName } from '../../../../shared/domain/ui-tools';
import {
  resolveAdvertisedUiTools,
  wiredUiTools,
} from '../../../../shared/domain/ui-tools-policy';
import type { McpServerRegistry } from '../../mcp';
import type { AgentRunPlan, MapperRegistry } from '../../agents/domain';
import type { McpServerConfig } from '../../../../shared/domain/mcp';
import type { MemoryRecall } from '../../../../shared/domain/memory';
import { memoryHintBudgetChars, replayBudgetChars } from '../../../../shared/domain/context-budget';
import { buildHandoffBrief } from '../../../../shared/domain/handoff';
import { buildConversationReplay } from '../../../../shared/domain/conversation-replay';
import type { ChatMessage } from '../../../../shared/domain/chat';
import type { DeviaConfig } from '../../../../shared/domain/config';
import { RunFileGate, rebindArchivedRunFile, type RunFileAdmission } from '../../../shared/outbound-file-gate';
import type { RunFile, RunFileSource } from '../../../shared/run-gateway';


/**
 * How long to wait for the user to answer an AskUserQuestion before killing
 * the process. Default is 5 minutes. Can be overridden via DeviaConfig in the
 * future — for now it is a module-level constant.
 *
 * REV-TS-CLI-05-01: without this timeout a hung AskUserQuestion holds
 * `isRunning === true` indefinitely, blocking all subsequent instructions for
 * the same project.
 */
const QUESTION_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

/** Devia's memory server id (its `mem_*` tools). */
const MEMORY_SERVER_ID = 'devia-memory';

/** S-2 F3.4: how fresh a previous-agent `mem_session_summary` must be to ride
 *  the handoff brief instead of the compressed/deterministic body. */
const HANDOFF_RICH_SUMMARY_MAX_AGE_MS = 15 * 60 * 1_000;

/** Tools that modify files on disk and therefore warrant a diff snapshot. */
const FILE_EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/**
 * True when a run-start failure looks like "the session we tried to resume no
 * longer exists" (Claude: "No conversation found with session ID …"; Codex:
 * "no session found / unknown thread …"). Used to drop the stale
 * `agentSessionId` so the next run starts fresh instead of failing repeatedly.
 */
function isSessionNotFoundError(message: string): boolean {
  return /(session|conversation|thread)[^\n]{0,80}(not found|no encontrada|does not exist|unknown)|no (recorded |matching )?(session|conversation|thread)/i.test(
    message,
  );
}


export interface RunInstructionHandlers {
  /**
   * Called as soon as the use case mints the runId and resolves all pre-flight
   * checks. The `runId` is forwarded to the renderer on every subsequent event
   * so concurrent or rapid stop/start cycles never interleave on the wrong
   * assistant message.
   */
  onProcessStart(payload: { runId: RunId; agentId: string }): void;
  onClaudeOutput(line: string, runId: RunId): void;
  onProcessEnd(payload: {
    runId?: RunId;
    code: number | null;
    error?: string;
    classification?: ErrorClassification;
    signal?: string;
    /** REV-AGENT-CORE-011: structured cancellation cause when set. */
    cancelReason?: CancelReason;
    /** E-DSK-09 #262 — recovery-action taxonomy forwarded onto `process:end`. */
    classifiedError?: ClassifiedError;
  }): void;
  onOutboxFile(file: OutboxFile): void;
  /**
   * The run ended because the account's usage limit was hit. Fires right before
   * `onProcessEnd`. `resetsAt` (epoch ms) is set when the agent said when it can
   * continue. Optional — callers that do not resume sessions omit it.
   */
  onRateLimited?(payload: { runId: RunId; agentId: string; resetsAt?: number }): void;
  /**
   * S-32: an outbox file this run may deliver to the remote chat, already
   * revalidated by the run's `RunFileGate`. Fired BEFORE `onProcessEnd` so the
   * relay has it when the run's `end` arrives. Optional: no relay, no publish.
   */
  onRunFile?(file: RunFile, runId: RunId): void;
  /** S-32: an outbox file that was archived but may not leave (name + reason only). */
  /**
   * S-32: a file that may not leave (name + reason only): an outbox file that
   * was archived but refused, or a `devia_send_file` request the main process
   * refused on revalidation (`source: 'tool'`).
   */
  onRunFileRejected?(rejection: { name: string; reason: string; source: RunFileSource }, runId: RunId): void;
  /**
   * Called when Claude emits an `AskUserQuestion` tool_use. The IPC layer
   * should forward this to the renderer as a `question:ask` event so the
   * user can type their reply. Optional — callers that do not support the
   * multi-turn protocol omit it and the question is silently dropped.
   */
  onQuestionAsk?(
    toolUseId: string,
    question: string,
    runId: RunId,
    options?: QuestionOption[],
    questions?: QuestionPrompt[],
  ): void;
  /**
   * Called when the agent invokes a `devia-ui` tool other than the question
   * card (S-25). The IPC layer forwards it to the renderer as a
   * `ui:tool-request` event. Optional — a caller that omits it gets no
   * interface tools, and the run's advertised set is narrowed accordingly.
   */
  onUiToolRequest?(
    callId: string,
    tool: UiToolName,
    input: unknown,
    runId: RunId,
    expectsAnswer: boolean,
  ): void;
  /**
   * Called when Claude emits a `tool_result` for a file-editing tool
   * (Edit, Write, MultiEdit). Used by the IPC layer to trigger a non-blocking
   * git diff snapshot. Optional — callers that do not support TS-CLI-10 omit it.
   */
  onFileToolResult?(toolUseId: string, cwd: string, runId: RunId): void;
}

/**
 * Runs one chat turn for the active project against the user's
 * currently-selected CLI adapter (claude / codex / gemini / opencode).
 * The use case owns the cross-cutting concerns — session continuity,
 * attachments, outbox flush — while the
 * adapter is responsible for spawning the right binary with the right
 * argv and translating its event stream back to the renderer.
 */
export class RunInstructionUseCase {
  constructor(private readonly deps: {
    config: ConfigRepository;
    sessions: SessionStore;
    state: StateStore;
    registry: ProcessTrackingRegistry;
    runner: AgentRunner;
    agents: CliAdapterRegistry;
    /**
     * Agent id → mapper (S-30 contract B). Everything that depends on WHICH
     * agent runs — MCP delivery, argv, system-prompt channel, stream decoding,
     * native dialogs — lives behind it; this use case never branches on an id.
     */
    mappers: MapperRegistry;
    attachments: AttachmentEnricher;
    outbox: OutboxFlusher;
    tech: TechDetector;
    /** Optional audit log — null in tests, real instance in production. */
    auditLog?: AgentAuditLog;
    /**
     * Optional prompt-pack registry (REV-AGENT-CORE-003). When absent, packs
     * are silently disabled; the run uses the baseline system prompt only.
     */
    promptPacks?: PromptPackRegistry;
    /**
     * Optional MCP server registry (REV-AGENT-CORE-004). When absent or empty,
     * runs proceed without an `--mcp-config` flag.
     */
    mcpServers?: McpServerRegistry;
    /**
     * Optional provider for Devia's bundled kanban MCP server config, keyed
     * by absolute project path. Delivered to Claude via `--mcp-config` so the
     * SDD planner's `kanban_*` tools load without the project `.mcp.json`
     * trust prompt (which can't be answered in Devia's headless runtime).
     */
    kanbanMcpServer?: (projectAbs: string) => McpServerConfig;
    /**
     * Optional provider for Devia's bundled `devia-memory` MCP server config
     * (S-1). Delivered to Claude via `--mcp-config` exactly like the kanban
     * server, gated by `config.memory.enabled`.
     */
    memoryMcpServer?: (projectAbs: string, agentId?: string) => McpServerConfig;
    /**
     * S-25: provider for Devia's bundled `devia-ui` MCP server config, keyed by
     * the PER-RUN rendezvous directory (not by project — unlike the other two
     * bundled servers). Delivered to Claude via `--mcp-config`.
     */
    uiMcpServer?: (
      uiDir: string,
      tools: readonly UiToolName[],
      harness?: UiServerHarness,
    ) => McpServerConfig;
    /**
     * S-30 T-356: the skills and sub-agents Devia manages. They travel with
     * every run to whichever agent is active; absent ⇒ none.
     */
    harnessCatalog?: HarnessCatalog;
    /**
     * S-25 F2.4: whether the user already chose to always allow this exact
     * action in this project. Keyed by the BASE checkout, like memory/kanban.
     */
    isConfirmationGranted?: (projectAbs: string, action: string) => boolean;
    /** S-25 F2.4: persists the "always allow" the user just chose. */
    grantConfirmation?: (projectAbs: string, action: string, agentId: string) => void;
    /**
     * Which UI tools this build can actually draw a card for. Defaults to
     * `IMPLEMENTED_UI_TOOLS`; injected so a test can exercise the generic path
     * for a tool whose card has not landed yet. Advertising a BLOCKING tool
     * with no card would hang the run until the kill timeout, which is exactly
     * what this narrowing prevents.
     */
    implementedUiTools?: readonly UiToolName[];
    /**
     * Provider of recent project memory summaries (E-DSK-13 phase A), newest
     * first. When present and `config.memory.enabled`, the use case pre-injects
     * them into the system prompt so the agent starts each run already aware of
     * prior sessions instead of having to call `mem_context` first. Returning an
     * empty array (or omitting the dep) skips the injection.
     */
    memoryContext?: (projectAbs: string, query: string) => MemoryRecall;
    /**
     * Passive-capture sinks (E-DSK-13 phase C). When present and
     * `config.memory.enabled`, the use case records the user prompt at the
     * start of every run and a terse auto summary at the end of substantive,
     * successful runs — so memory survives even if the agent never calls the
     * `mem_*` tools itself. Both are best-effort and never abort the run.
     */
    saveMemoryPrompt?: (projectAbs: string, content: string, sessionId?: string, agentId?: string) => void;
    saveMemorySummary?: (projectAbs: string, content: string, sessionId?: string, startedAt?: number, agentId?: string) => void;
    /**
     * Cross-agent handoff sink (S-2 F2.2): records the handoff brief in memory
     * as a non-auto, standalone session entry so it enters recall and search.
     */
    saveMemoryHandoff?: (projectAbs: string, content: string, sessionId?: string, agentId?: string) => void;
    /**
     * S-2 F2.3: synchronous read of a PRE-COMPUTED (background) LLM summary of
     * the handed-off session. Null on miss → the deterministic brief stands.
     * The choice is internal to the handoff step; latency stays zero.
     */
    handoffSummary?: (identity: string, sessionId: string) => string | null;
    /**
     * S-2 F3.4: rich handoff summary the PREVIOUS agent recorded via
     * `mem_session_summary` (the toast-action flow). Preferred over the F2.3
     * compressed one when fresh (< maxAgeMs). Null on miss.
     */
    recentHandoffSummary?: (projectAbs: string, sessionId: string, agentId: string, maxAgeMs: number) => string | null;
    /**
     * Cross-agent handoff notification port (S-2 F2.2 → F3.1). Called before
     * `onProcessStart` when this run continues a session another agent owned,
     * so the renderer can persist a divider message ahead of the run's stream.
     */
    onSessionHandoff?: (event: {
      project: string;
      fromAgentId: string;
      toAgentId: string;
      summary: string;
      runId: RunId;
    }) => void;
    /**
     * Detects known third-party memory MCP servers in the project (E-DSK-13
     * #322) so the runner can warn (provider-neutral) when they coexist with
     * Devia's memory without isolation.
     */
    detectExternalMemory?: (projectAbs: string) => string[];
    /**
     * Context-recovery sinks (E-DSK-13 Fase D). `markContextCompacted` is
     * called when the agent emits a `context_compacted` event mid-run;
     * `consumeMemoryReinjection` is checked once at the start of every run and
     * returns (and clears) whether a re-injection is owed because the agent
     * compacted its context since the last run. Both gated by
     * `config.memory.enabled`.
     */
    markContextCompacted?: (projectAbs: string) => void;
    consumeMemoryReinjection?: (projectAbs: string) => boolean;
    /**
     * Synchronous worktree guarantee for additional sessions (T-153).
     * When present and `config.worktreePerSession` is ON, the runner creates
     * (or reuses) a worktree for the session before spawning the agent.
     * Omitting this dep keeps pre-T-153 behaviour.
     */
    ensureSessionWorktree?: (ref: WorktreeRef) => EnsureWorktreeResult;
    /**
     * S-32: whether the remote chat relay (Telegram) is connected right now.
     * Read once per run, before the tool set is resolved. Absent ⇒ false, so
     * `devia_send_file` is never offered.
     */
    remoteRelayConnected?: () => boolean;
    /**
     * S-32: validates that a run cwd is a live session worktree
     * (`<deviaDir>/worktrees/...`), the only folder outside the workspace a
     * file may be sent from — and only when it is THIS run's cwd.
     */
    isLiveSessionWorktree?: (workdir: string) => boolean;
  }) {}

  execute(
    projectName: string,
    rawInstruction: string,
    attachmentPayloads: AttachmentPayload[],
    handlers: RunInstructionHandlers,
    /**
     * Run mode selected by the user (REV-AGENT-CORE-006). Defaults to
     * `'apply'` for back-compat with callers that pre-date the mode signal.
     */
    requestedMode: RunMode = 'apply',
    /**
     * Prompt pack ids selected for this turn (REV-AGENT-CORE-003).
     * Empty / undefined means "use baseline system prompt only".
     */
    promptPackIds: readonly string[] = [],
    /**
     * Where the run originated. `'remote'` (Telegram) means the user can't use
     * interactive question UI, so the runner appends the remote protocol to the
     * system prompt AND auto-answers any `AskUserQuestion` instead of waiting
     * for the 5-minute kill timeout. Defaults to `'renderer'` for back-compat.
     */
    origin: 'renderer' | 'remote' = 'renderer',
    /**
     * When true the run belongs to an additional (non-primary) session and
     * should be isolated in its own git worktree when `config.worktreePerSession`
     * is ON (T-153). Defaults to false so all existing callers see zero change.
     * The renderer does not yet send this signal (T-149/T-143 will); production
     * always receives false until then.
     */
    isolateSession = false,
    /**
     * Opaque identity string used for registry keying, queue dispatch, and
     * event routing to the renderer. Defaults to `projectName` so every
     * existing single-pane caller is byte-for-byte unaffected.
     *
     * Separating run identity from cwd source lets two panes of the SAME
     * base project run concurrently: each pane passes a unique runKey so
     * their registry records, queues, and renderer events never collide,
     * while `projectName` still drives cwd resolution, session/tech/memory
     * lookups, and worktree reference building.
     */
    runKey?: string,
    /**
     * Renderer-controlled session id (T-143). When provided for a brand-new
     * record it seeds `activeSessionId` so the worktree path is deterministic
     * and the renderer can clean it up by (project, sessionId) on pane close.
     */
    sessionId?: string,
    /**
     * S-2 F3.4: run with THIS agent instead of `cfg.agentId` — the "ask the
     * previous agent for a handoff summary" flow. The override run resumes
     * the previous agent's native session (its agentSessionId still owns the
     * record), so it must launch BEFORE the new agent's first run. Passive
     * memory capture is skipped for override runs: the internal request
     * prompt is not a user prompt, and the auto run-summary would overwrite
     * the rich `mem_session_summary` the agent just produced.
     */
    agentIdOverride?: string,
  ): void {
    // Identity: drives registry, queue, and renderer event `project:` field.
    // CWD / sessions / tech / memory always use projectName.
    const identity = runKey ?? projectName;
    const isRemote = origin === 'remote';
    // Mint a fresh runId for this execution. Threaded through every event
    // the renderer receives so concurrent runs or rapid stop/start cycles
    // never interleave on the wrong assistant message. (REV-AGENT-CORE-001)
    const runId = crypto.randomUUID() as RunId;
    // E-DSK-13 #318: real run start, so the auto session summary records a true
    // span (start preserved across turns of the same session via upsert).
    const runStartedAt = Date.now();
    console.log(`[devia:run] execute() — project="${projectName}" runId=${runId} mode=${requestedMode} promptChars=${rawInstruction.length}`);

    let saved: SavedAttachment[] = [];
    if (attachmentPayloads.length > 0) {
      try {
        saved = this.deps.attachments.saveAll(attachmentPayloads);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        handlers.onProcessEnd({ runId, code: 1, error: `Error guardando adjuntos: ${message}` });
        return;
      }
    }
    const augmented = this.deps.attachments.augmentInstruction(rawInstruction, saved);

    const record = this.deps.registry.getOrCreate(identity);
    if (record.isRunning) {
      console.log('[devia:run] early-exit: busy');
      handlers.onProcessEnd({ runId, code: 1, error: 'busy' });
      return;
    }

    const cfg = this.deps.config.get();
    if (!cfg.workspaceRoot) {
      console.log('[devia:run] early-exit: no workspaceRoot');
      handlers.onProcessEnd({ runId, code: 1, error: 'Workspace no configurado' });
      return;
    }

    const cwdResult = resolveAndValidateCwd(projectName, cfg.workspaceRoot);
    if (!cwdResult.ok) {
      console.log(`[devia:run] early-exit: cwd invalid — ${cwdResult.error}`);
      handlers.onProcessEnd({ runId, code: 1, error: cwdResult.error });
      return;
    }
    let cwd = cwdResult.resolvedPath;
    console.log(`[devia:run] cwd resolved → "${cwd}"`);
    // Memory + kanban project identity. MUST stay on the base checkout even
    // when the run executes inside a per-session worktree: keying the stores
    // by the effective cwd would derive a key unique per session (the worktree
    // path embeds the sessionId), fragmenting memory.json/kanban.json into
    // one store per session that no other session can ever read.
    const projectCheckout = cwdResult.resolvedPath;

    // Guard future imagePaths use: validate every image path against the
    // resolved project CWD before it can reach buildArgs or the CLI.
    // Currently imagePaths is always [] — this is a pre-emptive security gate.
    const imagePaths: string[] = [];
    const escapingPath = findEscapingImagePath(imagePaths, cwd);
    if (escapingPath !== null) {
      handlers.onProcessEnd({ runId, code: 1, error: `Image path is outside workspace: ${escapingPath}` });
      return;
    }

    if (!this.deps.sessions.isValidSessionId(record.activeSessionId)) {
      record.activeSessionId =
        sessionId && this.deps.sessions.isValidSessionId(sessionId)
          ? sessionId
          : this.deps.sessions.newSessionId();
    }
    this.deps.state.save();

    // Per-session worktree isolation (S-13 T-153, mandatory since S-3 F1.1).
    // The renderer only sends isolateSession=true when the pane actually has a
    // worktree, so the flag alone drives this — `worktreePerSession` no longer
    // gates it. Best-effort: a non-git project or a repo with no commits must
    // still run in the real checkout, so any worktree failure falls back to
    // the project cwd instead of aborting.
    if (isolateSession && this.deps.ensureSessionWorktree && record.activeSessionId) {
      const ref = worktreeRefFor(this.deps.config.deviaDir(), cwd, record.activeSessionId);
      const ensured = this.deps.ensureSessionWorktree(ref);
      if (ensured.ok && isPathContained(ref.worktreeDir, path.join(this.deps.config.deviaDir(), 'worktrees'))) {
        cwd = ref.worktreeDir;
        console.log(`[devia:run] worktree cwd → "${cwd}" (created=${ensured.created})`);
      } else {
        const reason = ensured.ok ? 'fuera de la raíz de worktrees' : ensured.code;
        console.log(`[devia:run] worktree isolation unavailable (${reason}); using project cwd`);
        handlers.onClaudeOutput(
          JSON.stringify({
            type: 'status',
            label: 'Aislamiento por worktree no disponible (repo sin git o sin commits); ejecutando en el directorio del proyecto.',
          }),
          runId,
        );
      }
    }

    let def = resolveCurrentAgent(this.deps.agents, this.deps.config);
    if (agentIdOverride !== undefined && agentIdOverride !== def.id) {
      const overrideDef = this.deps.agents.get(agentIdOverride);
      if (!overrideDef || (overrideDef.providerType ?? 'cli') !== 'cli') {
        console.log(`[devia:run] early-exit: agent override "${agentIdOverride}" not executable`);
        handlers.onProcessEnd({
          runId,
          code: 1,
          error: `El agente "${agentIdOverride}" no está disponible para este run.`,
        });
        return;
      }
      def = overrideDef;
    }
    const tech = this.deps.tech.detect(projectName);
    const modelPrefs = cfg.agentModels[def.id] ?? {};

    // REV-AGENT-CORE-005/006/007: mint a per-run capability descriptor with
    // the user-selected mode. Adapter defaults + user policy extend the
    // denylist (plan-mode also adds Edit/Write/MultiEdit/Bash inside
    // buildDefaultCapabilities).
    const mapper = this.deps.mappers.forDef(def);
    const userPolicy = cfg.agentToolPolicy?.[def.id] ?? {};
    const userDeny = sanitiseToolNames(userPolicy.disallow);
    // The agent's own mode-dependent denylist comes from its mapper (e.g.
    // Claude's `Workflow` outside plan, S-16 T-189); the user's policy extends it.
    const capabilities = buildDefaultCapabilities(runId, requestedMode, {
      defaultDisallowedTools: [...mapper.disallowedTools(requestedMode), ...userDeny],
    });

    // REV-AGENT-CORE-013: compose the system prompt once and dispatch by strategy.
    //   - 'argv'           → passed to buildExtraArgs (e.g. Claude --append-system-prompt).
    //   - 'stdin-prepend'  → forwarded to the launcher via CliRunRequest.systemPrompt.
    //   - 'argv-prepend'   → forwarded too; the launcher inlines it into the prompt argv (Grok).
    //   - 'unsupported'    → dropped with a one-shot debug warning.
    //
    // REV-AGENT-CORE-003: prompt packs append their bodies after the baseline,
    // separated by `---` dividers. Unknown ids are dropped silently by the
    // registry.
    const packBodies = this.deps.promptPacks
      ? this.deps.promptPacks.getBodies(promptPackIds)
      : [];
    // #269: append the skill-registry pointer as an extra "pack body" so it
    // shares the same `---` divider treatment as user-configured packs. The
    // helper returns null when the project has no registry yet.
    const skillRegistryHint = buildSkillRegistryHint(cwd);
    // E-DSK-13 phase A + #313: pre-inject recent project memory so the agent
    // begins already aware of prior sessions. Inject it ONCE per agent session
    // (first turn, or after a reset which clears agentSessionId) — re-sending it
    // every turn on a resumed session duplicates it in the agent's transcript
    // and busts prompt caching, since the memory block changes over time.
    // Resume the stored native session ONLY if it was produced by the currently
    // active agent. Native session ids are agent-specific (a Claude session is
    // not a Codex thread), so resuming another agent's id fails ("No conversation
    // found" / "no rollout found"). After switching agents the owner won't match
    // → start a fresh session (and treat it as a first turn so memory re-injects).
    const resumeSessionId = (record.agentSessionId && record.agentSessionAgentId === def.id)
      ? record.agentSessionId
      : undefined;
    const isFirstTurnOfSession = !resumeSessionId;
    // S-2 F2.2: cross-agent session handoff. When the active session was owned
    // by ANOTHER agent and has history, build a deterministic brief and inject
    // it directly into THIS run's system prompt (not via memory recall — the
    // first turn must be guaranteed), record it in memory, and notify the
    // renderer. Idempotent without a flag: when this run's `session_started`
    // arrives it overwrites agentSessionId+owner, so the mismatch clears
    // itself. Best-effort: a handoff failure never aborts the run.
    let handoffHint: string | null = null;
    if (record.agentSessionAgentId && record.agentSessionAgentId !== def.id) {
      const fromAgentId = record.agentSessionAgentId;
      try {
        const activeSession = record.activeSessionId
          ? this.deps.sessions.load(projectName, record.activeSessionId)
          : null;
        if (activeSession && activeSession.messages.length > 0) {
          // Summary preference (F3.4 > F2.3 > deterministic): a fresh rich
          // summary the previous agent recorded beats the background
          // compression; both fall back to the plain brief on miss.
          const richSummary = record.activeSessionId
            ? this.deps.recentHandoffSummary?.(projectCheckout, record.activeSessionId, fromAgentId, HANDOFF_RICH_SUMMARY_MAX_AGE_MS) ?? null
            : null;
          const summaryBody = richSummary
            ?? (record.activeSessionId
              ? this.deps.handoffSummary?.(identity, record.activeSessionId) ?? null
              : null);
          const brief = buildHandoffBrief(activeSession.messages as ChatMessage[], {
            workspaceRoot: cwd,
            ...(summaryBody !== null && { summaryBody }),
          });
          handoffHint = brief.rendered;
          if (cfg.memory.enabled) {
            try {
              this.deps.saveMemoryHandoff?.(
                projectCheckout,
                `Traspaso de sesión: de ${fromAgentId} a ${def.id}.\n\n${brief.rendered}`,
                record.activeSessionId ?? undefined,
                def.id,
              );
            } catch (err: unknown) {
              console.warn('[devia:run] memory handoff record failed:', err instanceof Error ? err.message : String(err));
            }
          }
          this.deps.onSessionHandoff?.({
            project: identity,
            fromAgentId,
            toAgentId: def.id,
            summary: brief.rendered,
            runId,
          });
        }
      } catch (err: unknown) {
        console.warn('[devia:run] session handoff failed (run continues):', err instanceof Error ? err.message : String(err));
      }
    }
    // S-19 F0.3: transcript re-seeding for `continuity: 'replay'` agents
    // (gemini, opencode). They expose no native session to resume, so the use
    // case otherwise sends only the latest turn and the agent loses all prior
    // context. Re-seed the prior conversation into the user prompt instead.
    // Skipped when a handoff brief is injected this run (it already carries the
    // tail — re-seeding too would duplicate history) and when there is no prior
    // history (first turn). Best-effort: a failure never aborts the run.
    let replayBlock: string | null = null;
    if (def.continuity === 'replay' && handoffHint === null && record.activeSessionId) {
      try {
        const replaySession = this.deps.sessions.load(projectName, record.activeSessionId);
        if (replaySession && replaySession.messages.length > 0) {
          replayBlock = buildConversationReplay(replaySession.messages as ChatMessage[], {
            maxChars: replayBudgetChars(def.id, modelPrefs.model ?? undefined),
            workspaceRoot: cwd,
          });
        }
      } catch (err: unknown) {
        console.warn('[devia:run] transcript replay failed (run continues):', err instanceof Error ? err.message : String(err));
      }
    }
    // E-DSK-13 Fase D: if the agent compacted its context since the last run,
    // re-inject memory now even on a resumed session — the older turns (and any
    // memory we injected then) were summarised away. consume() is one-shot.
    const reinjectAfterCompaction = cfg.memory.enabled
      ? (this.deps.consumeMemoryReinjection?.(projectName) ?? false)
      : false;
    const memoryContextHint = cfg.memory.enabled && (isFirstTurnOfSession || reinjectAfterCompaction)
      ? buildMemoryContextHint(
          this.deps.memoryContext?.(projectCheckout, rawInstruction) ?? { observations: [], summaries: [] },
          // E-DSK-13 #319: size the block to the active model's context window.
          { maxChars: memoryHintBudgetChars(def.id, modelPrefs.model ?? undefined) },
        )
      : null;
    // Per-run rendezvous directory for the UI tools. Created BEFORE the spawn
    // because the `devia-ui` MCP server starts with the agent and writes its
    // request files here.
    const uiDir = uiRunDir(runId);
    try {
      fs.mkdirSync(uiDir, { recursive: true });
    } catch (err: unknown) {
      console.warn(
        '[devia:run] could not create the devia-ui rendezvous directory:',
        err instanceof Error ? err.message : String(err),
      );
    }
    const cleanupUiDir = (): void => {
      try {
        fs.rmSync(uiDir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    };

    /**
     * S-25: which `devia-ui` tools reach the agent this run. Resolved BEFORE the
     * system prompt is composed, because the prompt has to either announce each
     * tool or tell the agent to fall back to plain text — and getting that wrong
     * is worse than either branch on its own.
     *
     * Whether they are DELIVERED is the agent mapper's call (`resolveDelivery`):
     * an enterprise MCP policy, an agent with no MCP config target, a failed
     * config write all mean "no". A remote (Telegram) run is NOT undelivered:
     * it keeps the three non-interactive tools and loses the rest, which is the
     * policy's job, not the delivery's.
     *
     * The set is computed first and the delivery second, because the server's
     * argv carries the set — so the candidate has to exist before it can be
     * delivered.
     */
    // S-30 T-356: the harness Devia manages travels with the run to whichever
    // agent is active — skills (read from the EFFECTIVE cwd: a skill belongs to
    // the checkout the agent works in) and sub-agents (Devia's source of truth
    // lives on the base checkout). `devia_skill` / `devia_subagent` serve them
    // to any agent; each mapper adds its CLI's native channel on top.
    const skills = this.deps.harnessCatalog?.skills(cwd) ?? [];
    const subagents = this.deps.harnessCatalog?.subagents(projectCheckout) ?? [];
    const skillsDirs = [...new Set(skills.map((s) => path.dirname(s.dir)))];
    const subagentsDir = subagents[0] ? path.dirname(subagents[0].file) : undefined;

    // S-32: `devia_send_file` needs a chat to send to (relay connected) that
    // this run talks through (a remote run, or the desktop mirror), and the
    // user's switch. The only roots are the workspace and — when it is THIS
    // run's cwd — a validated live session worktree; the attachments dir and
    // anything else are never roots, and apply-yolo widens nothing.
    const remoteControl = cfg.remoteControl as DeviaConfig['remoteControl'] | undefined;
    const canSendFiles =
      (this.deps.remoteRelayConnected?.() ?? false) &&
      (isRemote || remoteControl?.mirrorDesktop === true) &&
      remoteControl?.allowFileSend !== false;
    const sendRoots: readonly string[] = [
      cfg.workspaceRoot,
      ...(cwd !== projectCheckout && this.deps.isLiveSessionWorktree?.(cwd) === true ? [cwd] : []),
    ];
    // Devia's own data (transcripts, memory, attachments, outbox archive) never
    // leaves, even when the workspace root contains it; a live session
    // worktree under `<deviaDir>/worktrees/` stays usable (it IS a send root).
    // A workspace root that is the home folder (or above it) is refused by the
    // guard itself, with a message the agent relays to the user.
    const sendDenyRoots: readonly string[] = [this.deps.config.deviaDir()];

    const uiCandidate = wiredUiTools(
      resolveAdvertisedUiTools({
        mode: requestedMode,
        isRemote,
        delivered: true,
        // `devia_skill` serves both skills and sub-agents.
        hasSkills: skills.length > 0 || subagents.length > 0,
        canSendFiles,
        ...(cfg.uiTools?.enabled && { preferences: cfg.uiTools.enabled }),
      }),
      this.deps.implementedUiTools,
    );
    // S-19 F0.3: for 'replay' agents the prior conversation precedes the
    // current instruction in the same user payload. Native-resume agents
    // (replayBlock === null) send the instruction unchanged — byte-identical.
    const promptToSend = replayBlock
      ? `${replayBlock}\n\n## Mensaje actual del usuario\n${augmented}`
      : augmented;

    // Devia's bundled servers, in delivery order (kanban, memory, ui).
    const kanbanServer = this.deps.kanbanMcpServer?.(projectCheckout);
    const memoryServer = cfg.memory.enabled ? this.deps.memoryMcpServer?.(projectCheckout, def.id) : undefined;
    const uiServer =
      uiCandidate.length > 0
        ? this.deps.uiMcpServer?.(uiDir, uiCandidate, {
            skillsDirs,
            ...(subagentsDir !== undefined && { subagentsDir }),
            ...(uiCandidate.includes('send_file') && { sendRoots, cwd, denyRoots: sendDenyRoots }),
          })
        : undefined;
    const deviaServers = (withUi: boolean): McpServerConfig[] => [
      ...(kanbanServer ? [kanbanServer] : []),
      ...(memoryServer ? [memoryServer] : []),
      ...(withUi && uiServer ? [uiServer] : []),
    ];
    const basePlan: AgentRunPlan = {
      runId,
      agentId: def.id,
      mode: requestedMode,
      cwd,
      projectCheckout,
      deviaDir: this.deps.config.deviaDir(),
      prompt: promptToSend,
      imagePaths,
      // Whole-workspace visibility so a project can reference its siblings.
      // Confined modes only — `apply-yolo` already runs without confinement.
      extraAllowedDirs: requestedMode !== 'apply-yolo' && cfg.workspaceRoot ? [cfg.workspaceRoot] : [],
      ...(resumeSessionId !== undefined && { resumeSessionId }),
      model: modelPrefs.model ?? null,
      reasoning: modelPrefs.reasoning ?? null,
      envOverrides: cfg.agentCliEnv[def.id] ?? {},
      capabilities,
      isRemote,
      harness: {
        mcp: {
          devia: deviaServers(true),
          // REV-AGENT-CORE-005: narrowed to the run's MCP allowlist.
          user: this.deps.mcpServers?.enabled(capabilities.allowedMcpServerIds) ?? [],
        },
        skills,
        subagents,
        isolateExternalMcp: cfg.memory.blockExternalMemory,
      },
      ui: { rendezvousDir: uiDir, toolTimeoutMs: QUESTION_TIMEOUT_MS },
    };
    const delivery = mapper.resolveDelivery(basePlan);
    // S-1 T-12 + E-DSK-13 #313: announce the memory protocol ONLY when the
    // `devia-memory` tools actually reach this agent — decided by its mapper's
    // delivery, not a per-agent table. Telling an agent without them to "call
    // mem_*" would be a lie; Devia still captures passively and injects
    // read-only context.
    const memoryHint = buildMemoryProtocolHint(cfg.memory.enabled && delivery.mcpServerIds.includes(MEMORY_SERVER_ID));
    const uiDelivered = uiServer !== undefined && delivery.mcpServerIds.includes(UI_SERVER_ID);
    // An undelivered `devia-ui` must not be materialised either.
    const plan: AgentRunPlan = uiDelivered
      ? basePlan
      : { ...basePlan, harness: { ...basePlan.harness, mcp: { ...basePlan.harness.mcp, devia: deviaServers(false) } } };
    let uiAdvertised: UiToolName[] = uiDelivered ? uiCandidate : [];

    // Remote (Telegram) runs: tell the agent interactive question tools don't
    // work here and to ask in plain text instead (paired with the runtime
    // auto-answer safety net below).
    // S-32: the "send it as a file" bullet only when a file can really leave this
    // run — via the tool, or via `outbox/` (which plan mode cannot write).
    const filesReachable = canSendFiles && (uiAdvertised.includes('send_file') || requestedMode !== 'plan');
    const remoteHint = buildRemoteProtocolHint(isRemote, filesReachable);
    // S-25: the inverse of announcing the tools — for every capability this run
    // does NOT have, the agent still has to know how to get there in plain text
    // instead of guessing or going silent.
    // S-32: a run that can reach the chat but did not get `devia_send_file` is
    // told about the `outbox/` channel instead (or, in plan mode, that it can't).
    const uiFallbackHint = buildUiFallbackHint(uiAdvertised, { canSendFiles, mode: requestedMode });
    // S-3 F3: mandatory isolation rules whenever the run's cwd is a session
    // worktree — derived from the cwd itself (covers both the eager renderer
    // worktree and a re-attached one), never from the isolateSession flag.
    const worktreeHint = buildWorktreeProtocolHint(cwd !== cwdResult.resolvedPath);
    // Plan mode blocks file-writers but keeps the kanban MCP: tell the agent to
    // persist long plans as kanban specs instead of attempting failing writes.
    const planHint = buildPlanProtocolHint(requestedMode === 'plan');
    const allBodies = [
      ...packBodies,
      ...(skillRegistryHint ? [skillRegistryHint] : []),
      ...(memoryHint ? [memoryHint] : []),
      ...(memoryContextHint ? [memoryContextHint] : []),
      ...(handoffHint ? [handoffHint] : []),
      ...(worktreeHint ? [worktreeHint] : []),
      ...(remoteHint ? [remoteHint] : []),
      ...(uiFallbackHint ? [uiFallbackHint] : []),
      ...(planHint ? [planHint] : []),
    ];
    // Built here (not earlier) because the baseline only offers the tools this
    // run actually got.
    const baseline = buildSystemPrompt(tech, { advertised: uiAdvertised });
    const systemPrompt = composeSystemPrompt(baseline, allBodies);
    if (def.systemPromptStrategy === 'unsupported') {
      console.warn(
        `[devia:run] systemPromptStrategy=unsupported for agent ${def.id} — system prompt is dropped.`,
      );
    }

    // The agent's mapper turns the plan into argv / stdin / env / temp files —
    // MCP delivery, the system-prompt channel, resume flags, permission flags.
    const prepareResult = mapper.prepareRun(plan, systemPrompt, delivery);
    const prepared = prepareResult.ok ? prepareResult.run : null;
    // A temp-file write can fail after the prompt was composed: stop serving
    // the cards of a server that never reached the agent.
    if (prepared !== null && !prepared.mcpServerIds.includes(UI_SERVER_ID)) {
      uiAdvertised = [];
    }
    const runNotices = [...delivery.notices, ...(prepared?.notices ?? [])];

    handlers.onProcessStart({ runId, agentId: def.id });

    // E-DSK-13 phase C: passively record the user's prompt so memory captures
    // intent even if the agent never calls mem_save_prompt. Best-effort; gated.
    // F3.4: override runs skip it — their prompt is an internal request, not
    // something the user typed.
    if (cfg.memory.enabled && this.deps.saveMemoryPrompt && agentIdOverride === undefined) {
      try {
        this.deps.saveMemoryPrompt(projectCheckout, sanitizeForMemory(rawInstruction), record.activeSessionId ?? undefined, def.id);
      } catch (err: unknown) {
        console.warn('[devia:run] memory savePrompt failed:', err instanceof Error ? err.message : String(err));
      }
    }

    // The mapper's notices (enterprise MCP policy, unsupported MCP — UC-FIX-005)
    // appear in the chat bubble right after the stream opens.
    for (const label of runNotices) {
      handlers.onClaudeOutput(JSON.stringify({ type: 'status', label }), runId);
    }

    // E-DSK-13 #322: provider-neutral coexistence warning — when Devia's memory
    // is on AND external memory is NOT isolated AND a known third-party memory
    // MCP is present in the project, both will inject context. Surface it once.
    if (cfg.memory.enabled && !cfg.memory.blockExternalMemory) {
      const external = this.deps.detectExternalMemory?.(cwd) ?? [];
      if (external.length > 0) {
        handlers.onClaudeOutput(
          JSON.stringify({
            type: 'status',
            label: `Memoria externa detectada (${external.join(', ')}) junto a la memoria de Devia. Para evitar solapamientos, elige "Devia" como proveedor de memoria en Ajustes → Memoria.`,
          }),
          runId,
        );
      }
    }

    // Track tool_use ids whose tool is a file-editing tool, so that when
    // the matching tool_result arrives we can fire onFileToolResult.
    // Scoped to this run — cleared automatically when the process ends.
    const fileEditingToolIds = new Set<string>();

    // E-DSK-13 phase C: count tool_use events this run to (a) decide whether the
    // run was substantive enough to auto-summarise and (b) report it in the
    // summary. Scoped to this run; reset on every execute().
    let toolUseCount = 0;

    // T-194: whether this run ever captured a native session id. Used to warn
    // if a run dies before any id arrives, so the next turn silently
    // restarting without context is not invisible.
    let sessionIdCaptured = false;

    // Set when the agent reports the account's usage limit is exhausted.
    let rateLimited: { resetsAt?: number } | null = null;
    const reportRateLimit = (): void => {
      if (rateLimited === null) return;
      handlers.onRateLimited?.({
        runId,
        agentId: def.id,
        ...(rateLimited.resetsAt !== undefined && { resetsAt: rateLimited.resetsAt }),
      });
    };

    // S-32: this run's send-file policy + counter, beside the advertised set.
    // Every outbound file (the tool now, the outbox in T-367) is revalidated
    // through it before anything is published.
    const fileGate = new RunFileGate({
      canSendFiles,
      sendRoots,
      cwd,
      denyRoots: sendDenyRoots,
      audit: {
        ...(this.deps.auditLog !== undefined && { log: this.deps.auditLog }),
        ctx: { agentId: def.id, project: projectName, runId, mode: capabilities.mode },
      },
    });

    // Everything that puts a question in front of the user and carries the
    // answer back: devia-ui cards, the agent's own dialogs, the kill timer.
    const interaction = new RunInteraction({
      runId,
      agentId: def.id,
      projectName,
      projectCheckout,
      cwd,
      uiDir,
      mode: capabilities.mode,
      isRemote,
      advertised: uiAdvertised,
      files: fileGate,
      timeoutMs: QUESTION_TIMEOUT_MS,
      handlers,
      ...(this.deps.auditLog !== undefined && { auditLog: this.deps.auditLog }),
      ...(this.deps.isConfirmationGranted !== undefined && { isConfirmationGranted: this.deps.isConfirmationGranted }),
      ...(this.deps.grantConfirmation !== undefined && { grantConfirmation: this.deps.grantConfirmation }),
    });
    // Agent-agnostic since S-24: whoever got the server publishes its requests
    // to the rendezvous, so polling follows the delivery, not the agent id.
    interaction.start();

    // S-32: the outbox is flushed from the EFFECTIVE cwd (the worktree of an
    // isolated pane) BEFORE `onProcessEnd`, so a relay-bound file is on the
    // gateway when the run's `end` arrives. Each file is validated by the gate
    // at its ORIGINAL path — inside the outbox, hence inside the send roots —
    // and only then moved; the published `RunFile` points at the ARCHIVED copy,
    // which is where the relay reads it after `end`. That archive path is
    // minted by Devia (`<deviaDir>/outbox-archive/<ts>_<name>`, a plain move of
    // the regular file just validated), so it is trusted although it lies
    // outside the roots. The renderer still gets `outbox:file` AFTER
    // `process:end`, so its card lands below the finalised reply as before.
    const flushOutbox = (): OutboxFile[] => {
      try {
        const check = fileGate.canSendFiles
          ? (entry: { path: string }): RunFileAdmission => fileGate.admit({ path: entry.path }, 'outbox')
          : undefined;
        const flushed = this.deps.outbox.flush(cwd, check);
        for (const { file, verdict } of flushed) {
          if (!fileGate.canSendFiles) continue;
          // The published path is the ARCHIVED copy; its identity is the one
          // admitted (a rename keeps the inode) or re-bound after a copy.
          const archived = verdict?.ok ? rebindArchivedRunFile(verdict.file, file.path) : null;
          if (archived) {
            handlers.onRunFile?.(archived, runId);
          } else if (verdict?.ok) {
            handlers.onRunFileRejected?.({ name: file.name, reason: 'changed', source: 'outbox' }, runId);
          } else {
            // No verdict = not a regular file (a symlink): archived, never sent.
            const reason = verdict ? verdict.reason : 'not_a_file';
            handlers.onRunFileRejected?.({ name: file.name, reason, source: 'outbox' }, runId);
          }
        }
        return flushed.map(({ file }) => ({ ...file, project: projectName }));
      } catch (err: unknown) {
        console.warn('[devia:run] outbox flush failed:', err instanceof Error ? err.message : String(err));
        return [];
      }
    };
    const emitOutbox = (files: readonly OutboxFile[]): void => {
      for (const file of files) handlers.onOutboxFile(file);
    };

    const runHandlers: AgentRunHandlers = {
        onOutput: (line) => {
          try {
            const parsed = JSON.parse(line) as AgentEvent;

            // Capture agent-generated session ID the moment it arrives.
            // This is the ONLY place agentSessionId is ever written.
            if (parsed.type === 'session_started') {
              sessionIdCaptured = true;
              const rec = this.deps.registry.find(identity);
              if (rec) {
                rec.agentSessionId = parsed.agentSessionId;
                // Tag the owning agent so a later run with a DIFFERENT agent
                // doesn't try to resume this (agent-specific) session id.
                rec.agentSessionAgentId = def.id;
                this.deps.state.save();
              }
            }

            // E-DSK-13 Fase D: the agent compacted its context mid-run. Flag the
            // identity so the next run re-injects Devia's memory (Fase A only
            // injects on the first turn of a session, so a resumed-but-compacted
            // session would otherwise never recover it).
            if (parsed.type === 'context_compacted' && cfg.memory.enabled) {
              this.deps.markContextCompacted?.(identity);
            }

            if (parsed.type === 'rate_limit' && parsed.status === 'rejected') {
              rateLimited = parsed.resetsAt !== undefined ? { resetsAt: parsed.resetsAt } : {};
            }

            // Intercept tool_result events for file-editing tools to trigger
            // a non-blocking diff snapshot.
            if (
              handlers.onFileToolResult &&
              parsed.type === 'tool_result' &&
              fileEditingToolIds.has(parsed.toolUseId)
            ) {
              handlers.onFileToolResult(parsed.toolUseId, cwd, runId);
            }
            // Every agent's tool calls (not only Claude's): audit trail, the
            // auto run summary, diff snapshots and the AskUserQuestion safety net.
            if (parsed.type === 'tool_use' && interaction.firstSighting(parsed.id)) {
              const { id, name, input } = parsed;
              // E-DSK-13 phase C: tally tool_use events for the auto run summary.
              toolUseCount += 1;
              // FR-3: audit each tool_use with structural metadata only — never
              // prompt text or tool inputs; runId + mode make it correlatable.
              this.deps.auditLog?.append({
                ts: Date.now(),
                agentId: def.id,
                project: projectName,
                tool: name,
                runId,
                mode: capabilities.mode,
              });
              if (FILE_EDITING_TOOLS.has(name)) fileEditingToolIds.add(id);
              if (name === ASK_USER_QUESTION_TOOL) interaction.surfaceBuiltInQuestion(id, input);
            }
            // `tool_use` is the pause point where Claude waits for the
            // renderer's tool_result: keep the question timer alive until the
            // answer is written or a final turn end arrives.
            if (parsed.type === 'turn_end' && parsed.stopReason !== 'tool_use') interaction.clearQuestionTimer();
          } catch {
            /* non-JSON lines are fine */
          }
          handlers.onClaudeOutput(line, runId);
        },
        onDone: (code) => {
          interaction.stop();
          cleanupUiDir();
          // Every temp artifact the mapper prepared (MCP config, system prompt file).
          prepared?.cleanup();
          this.deps.registry.detachProcess(identity);
          // E-DSK-13 phase C: passive auto session summary. Only for successful
          // runs that actually did something, so the recent-memory feed isn't
          // flooded with no-op turns. The agent's own mem_session_summary
          // (phase B protocol) still produces the richer entries when it runs.
          // F3.4: never auto-summarise an override run — the terse auto entry
          // would upsert over the rich mem_session_summary the previous agent
          // just recorded for the handoff.
          if (cfg.memory.enabled && this.deps.saveMemorySummary && code === 0 && toolUseCount > 0 && agentIdOverride === undefined) {
            try {
              this.deps.saveMemorySummary(
                projectCheckout,
                buildRunSummary(rawInstruction, toolUseCount, code),
                record.activeSessionId ?? undefined,
                runStartedAt,
                def.id,
              );
            } catch (err: unknown) {
              console.warn('[devia:run] memory sessionSummary failed:', err instanceof Error ? err.message : String(err));
            }
          }
          reportRateLimit();
          const outboxFiles = flushOutbox();
          handlers.onProcessEnd({ runId, code });
          emitOutbox(outboxFiles);
        },
        onError: (msg, classification, signal, cancelReason, classifiedError) => {
          interaction.stop();
          cleanupUiDir();
          prepared?.cleanup();
          this.deps.registry.detachProcess(identity);
          // Resume fallback: if this run tried to resume a session the agent no
          // longer knows (rotated/purged session files, CLI upgrade), clear the
          // stored id so the NEXT run starts a fresh session instead of failing
          // the same way forever. Conservative match — never clears on
          // unrelated errors (auth, network, sandbox).
          if (resumeSessionId !== undefined && isSessionNotFoundError(msg)) {
            const rec = this.deps.registry.find(identity);
            if (rec) {
              rec.agentSessionId = null;
              rec.agentSessionAgentId = null;
              this.deps.state.save();
              console.warn(
                `[devia:run] resume of session ${resumeSessionId} failed (not found) — cleared agentSessionId for "${identity}"`,
              );
            }
          }
          // T-194 secondary safeguard: a run that died (cancel / question
          // timeout / crash) before ever capturing a native session id leaves
          // nothing for the next turn to resume — it would restart from scratch
          // and lose context. With the `system`/`init` capture this only
          // triggers on a crash before the first stream line; a resumable id
          // already on record means the thread survives. Diagnostic only for
          // now: surfacing this to the user as a translated status notice is
          // tracked in T-90 (status labels → i18n keys; the renderer does not
          // render status `label` today).
          if (!sessionIdCaptured) {
            const rec = this.deps.registry.find(identity);
            const resumableId = rec && rec.agentSessionAgentId === def.id ? rec.agentSessionId : null;
            if (!resumableId) {
              console.warn(
                `[devia:run] run for "${identity}" ended without ever capturing a native session id — next turn will start a fresh thread with no prior context.`,
              );
            }
          }
          reportRateLimit();
          const outboxFiles = flushOutbox();
          handlers.onProcessEnd({
            runId,
            code: 1,
            error: msg,
            ...(classification !== undefined && { classification }),
            ...(signal !== undefined && { signal }),
            ...(cancelReason !== undefined && { cancelReason }),
            ...(classifiedError !== undefined && { classifiedError }),
          });
          emitOutbox(outboxFiles);
        },
        // A dialog the agent raised natively (pi extension UI, ACP permission),
        // already in Devia's terms. Drawn through the same card pipeline as the
        // `devia-ui` tools; the answer returns through `trackedHandle`.
        onUiRequest: (req) => interaction.surfaceAgentUiRequest(req),
      };

    if (prepared === null) {
      // The mapper refused to prepare the run (e.g. the prompt does not fit an
      // argv-bound CLI). Same outcome as a spawn failure, nothing to attach.
      runHandlers.onError(prepareResult.ok ? 'unreachable' : prepareResult.error);
      return;
    }

    const handle = this.deps.runner.run(
      {
        def,
        cwd,
        prepared,
        openSession: (io) => mapper.openSession(io, plan),
        mode: requestedMode,
        runId: runId as string,
      },
      runHandlers,
    );
    interaction.attach(handle);
    const trackedHandle: ProcessHandle = {
      kill: (reason?: CancelReason) => handle.kill(reason),
      // The renderer's answer to ANY card arrives here as a string.
      writeToolResult: (toolUseId: string, content: string): void => interaction.answer(toolUseId, content),
    };
    this.deps.registry.attachProcess(identity, trackedHandle, runId);
  }

}
