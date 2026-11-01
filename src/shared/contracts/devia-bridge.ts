import type { DeviaConfig, DeviaConfigView } from '../domain/config';
import type {
  EngramDetectionResult,
  ImportEngramResult,
  MemoryScope,
  MemorySearchHit,
  MemorySearchQuery,
  MemorySession,
  Observation,
} from '../domain/memory';
import type { NewFromBaseResult } from '../domain/base';
import type { RemoteControlStatus, TelegramTestResult } from '../domain/remote-control';
import type { UpdateStatus } from '../domain/update';
import type { ProjectEntry, PinnedEntry } from '../domain/project';
import type { SessionMeta } from '../domain/session';
import type {
  ImportableAgent,
  ImportOptions,
  ImportSelection,
  ImportSummary,
} from '../domain/session-import';
import type { SessionStats, SessionStatsAggregate } from '../domain/session-stats';
import type { GitInfo, DiffResult, GitSyncResult, BranchRef, BranchCheckoutRef, CheckoutResult } from '../domain/git';
import type { WorktreeView, WorktreeListItem } from '../domain/worktree';
import type { StatusInfo } from '../domain/status';
import type { AttachmentPayload } from '../domain/attachment';
import type { CloneRequest } from '../domain/clone';
import type { ComposeAction } from '../domain/compose';
import type { IdeId, IdeInfo } from '../domain/ide';
import type {
  ProcessStartEvent,
  SessionHandoffEvent,
  SessionResetEvent,
  AutoResumeScheduledEvent,
  AutoResumeCancelledEvent,
  ProcessEndEvent,
  ClaudeOutputEvent,
  ComposeStartEvent,
  ComposeOutputEvent,
  ComposeEndEvent,
  CloneStartEvent,
  CloneOutputEvent,
  CloneEndEvent,
  GitInfoChangedEvent,
  NotificationClickEvent,
  RemoteSelectProjectEvent,
  RunModeChangedEvent,
  TerminalDataEvent,
  TerminalExitEvent,
  QuestionAskEvent,
  UiToolRequestEvent,
  DiffSnapshotEvent,
  AgentsDetectedEvent,
} from './events';
import type { OutboxFile } from '../domain/attachment';
import type {
  AgentChangedEvent,
  DetectedAgentView,
  RunId,
  SetAgentEnvInput,
  SetAgentModelInput,
} from '../domain/agent';
import type {
  ProjectQueueView,
  QueueChangedEvent,
  QueueDispatchedEvent,
  QueueItem,
  SendInstructionResult,
} from '../domain/queue';
import type {
  DiscoverSkillsRequest,
  DiscoverSkillsResult,
  InstallSkillsRequest,
  ListSkillsResult,
  RemoveSkillRequest,
  SkillsRunResult,
} from '../domain/skill';
import type { ProjectTreeResult } from '../domain/project-tree';
import type {
  SkillRegistrySnapshot,
  SkillRegistryRefreshResult,
  SkillRegistryChangedEvent,
} from '../domain/skill-registry';
import type {
  ListSnapshotsQuery,
  SnapshotFeature,
  SnapshotRestoreResult,
  SnapshotSummary,
} from '../domain/snapshot';
import type {
  McpAgentId,
  McpInstallResult,
  McpProbeResult,
  McpScope,
  McpServerView,
  McpSource,
} from '../domain/mcp';
import type {
  SubAgent,
  SubAgentCliId,
  SubAgentImportResult,
  SubAgentInstallResult,
  SubAgentView,
} from '../domain/sub-agents';
import type {
  BootstrapView,
  ProjectClassification,
  SddNotification,
  SddNotificationEvent,
  SddPromptResult,
} from '../domain/sdd';
import type {
  BlockReason,
  KanbanAgentWakeEvent,
  KanbanBoardView,
  KanbanChangedEvent,
  KanbanColumn,
  KanbanTaskView,
} from '../domain/kanban';

/**
 * A single audit log entry returned by the `audit:read` IPC channel.
 * Mirrors `AuditEntry` in `src/main/features/security/audit-log.ts`.
 * Re-declared here so the renderer's tsconfig (no @types/node) can type it.
 */
export interface AuditEntry {
  ts: number;
  agentId: string;
  project: string;
  tool: string;
  summary?: string;
  /** REV-AGENT-CORE-001: run identifier correlating this entry to a specific run. */
  runId?: RunId;
  /** REV-AGENT-CORE-005: run mode in effect when this tool ran. */
  mode?: 'plan' | 'apply' | 'apply-yolo';
}

export interface DialogPickOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalStartResult {
  pid: number;
  cwd: string;
  shell: string;
  /** True when an existing pty for the project was returned (no fresh spawn). */
  reused: boolean;
}

/**
 * Mirror of Node's `NodeJS.Platform` union. Re-declared locally so the
 * renderer's tsconfig — which has `"types": []` and does not pull in
 * `@types/node` — can still type the bridge.
 */
export type Platform =
  | 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux'
  | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd';

/**
 * Bridge exposed by preload via `contextBridge.exposeInMainWorld('devia', ...)`.
 * Every method here maps to exactly one IPC channel; payloads stay in sync via
 * the same `shared/contracts/events.ts` map the main process uses for typed
 * sends, so a renamed channel breaks the build on both sides at once.
 */
export interface DeviaBridge {
  readonly platform: Platform;
  /** True when running on a Linux kernel inside WSL (Windows Subsystem for
   *  Linux). Detected via the WSL_DISTRO_NAME env var, which wslg/WSL2 both
   *  set automatically. Used by the renderer to warn that some host↔guest
   *  features (notably clipboard image paste) won't work through wslg. */
  readonly isWSL: boolean;

  // Workspace + config
  listProjects(subpath?: string): Promise<ProjectEntry[]>;
  searchProjects(query: string): Promise<ProjectEntry[]>;
  newProject(name: string, parent?: string): Promise<string>;
  newFolder(name: string, parent?: string): Promise<string>;
  renameFolder(folderPath: string, newName: string): Promise<string>;
  moveProject(sourcePath: string, targetFolderPath: string): Promise<string>;
  listBases(): Promise<string[]>;
  readBasesJson(): Promise<{ text: string; filePath: string }>;
  writeBasesJson(text: string): Promise<{ count: number }>;
  newFromBase(base: string, name: string, parent?: string): Promise<NewFromBaseResult>;
  trashProject(projectPath: string): Promise<true>;
  getConfig(): Promise<DeviaConfigView>;
  setConfig(partial: Partial<DeviaConfig>): Promise<DeviaConfigView>;
  pickFolder(opts?: DialogPickOptions): Promise<string | null>;
  pickFile(opts?: DialogPickOptions): Promise<string | null>;

  // Sessions
  loadChats(): Promise<Record<string, unknown[]>>;
  /** Active-session rollup per project (S-7) — for restoring the footer at startup. */
  loadActiveStats(): Promise<Record<string, SessionStats>>;
  /** Devia-wide cost aggregate across every project's sessions (S-7). */
  aggregateStats(): Promise<SessionStatsAggregate>;
  saveChat(projectPath: string, messages: unknown[], stats?: SessionStats, runMode?: RunModeChangedEvent['mode']): Promise<true>;
  /**
   * Split-view save (S-13 T-156): persist an additional pane's history under
   * its base project with its own session id, without touching the project's
   * active session. The renderer keys the live state by the pane's runKey but
   * the disk file must live under the real project so it's listable/restorable.
   */
  saveChatAs(baseProject: string, sessionId: string, messages: unknown[], stats?: SessionStats, workdir?: string, worktreeBranch?: string, runMode?: RunModeChangedEvent['mode']): Promise<true>;
  listSessions(projectPath: string): Promise<SessionMeta[]>;
  switchSession(
    projectPath: string,
    sessionId: string,
  ): Promise<{ id: string; messages: unknown[]; stats?: SessionStats; runMode?: RunModeChangedEvent['mode'] }>;
  /**
   * S-2 F5.1: load an existing session under an ADDITIONAL pane's identity
   * (runKey) without touching the primary pane's record. Rejects with
   * SESSION_BUSY / SESSION_QUEUE_PENDING. S-3 F2.2: the result carries the
   * EFFECTIVE workdir from the recovery chain (live worktree → recreated from
   * branch → base checkout) so the pane re-keys onto the right cwd.
   */
  adoptSession(
    baseProject: string,
    runKey: string,
    sessionId: string,
  ): Promise<{
    id: string;
    messages: unknown[];
    stats?: SessionStats;
    runMode?: RunModeChangedEvent['mode'];
    workdir: string;
    branch?: string;
    isolation: 'worktree' | 'recreated' | 'none';
  }>;
  deleteSession(projectPath: string, sessionId: string): Promise<{ wasActive: boolean }>;

  /**
   * S-20: scan every supported agent's transcript storage for sessions that
   * map to a project inside the workspace, so the user can import them.
   */
  scanSessionImport(): Promise<ImportableAgent[]>;
  /** S-20: import the selected agent sessions into Devia's session store. */
  runSessionImport(selections: ImportSelection[], opts?: ImportOptions): Promise<ImportSummary>;

  // Claude runner. Returns whether the call ran inline or was parked in
  // the project's queue. Renderers use the result to show "encolada (#N)"
  // feedback without having to disambiguate from the queue:changed event.
  /**
   * Submit a chat instruction for the project. The optional `mode` (default
   * `'apply'`) selects the Plan / Apply / Apply-yolo permission shape — see
   * REV-AGENT-CORE-006. `displayText` is the user-facing bubble text for
   * system-built prompts (SDD planner / wake): if the call is queued, the
   * later `queue:dispatched` event carries it so the renderer never prints
   * the raw internal prompt as a user message.
   */
  sendInstruction(
    project: string,
    text: string,
    attachments?: AttachmentPayload[],
    mode?: 'plan' | 'apply' | 'apply-yolo',
    displayText?: string,
    /**
     * Split-view run options (S-13 T-143): `runKey` is the per-session identity
     * the renderer routes state by (defaults to `project` ⇒ single-pane
     * unchanged); `isolate` runs the session in its own git worktree.
     * `agentIdOverride` (S-2 F3.4) runs with a specific agent instead of the
     * configured one — the handoff-summary request flow.
     */
    runOpts?: { runKey?: string; isolate?: boolean; sessionId?: string; agentIdOverride?: string },
  ): Promise<SendInstructionResult>;
  stopProject(project: string): Promise<boolean>;
  resetSession(project: string): Promise<boolean>;
  stopAll(): Promise<string[]>;
  /**
   * Cancel a specific run by its id (REV-AGENT-CORE-001). Silent no-op if
   * the run already terminated.
   */
  cancelRun(runId: string): Promise<void>;
  /** REV-AGENT-CORE-003: list available prompt packs (summaries only). */
  listPromptPacks(): Promise<Array<{
    id: string;
    name: string;
    description: string;
    triggers?: string[];
    source: 'built-in' | 'user';
  }>>;
  /** REV-AGENT-CORE-003: re-scan the prompt-packs directory and return the new list. */
  rescanPromptPacks(): Promise<Array<{
    id: string;
    name: string;
    description: string;
    triggers?: string[];
    source: 'built-in' | 'user';
  }>>;

  // Per-project instruction queue
  listQueue(project: string): Promise<ProjectQueueView>;
  addToQueue(project: string, text: string): Promise<QueueItem>;
  removeFromQueue(project: string, id: string): Promise<boolean>;
  editInQueue(project: string, id: string, text: string): Promise<boolean>;
  moveInQueue(project: string, id: string, newIndex: number): Promise<boolean>;
  clearQueue(project: string): Promise<boolean>;
  pauseQueue(project: string): Promise<boolean>;
  resumeQueue(project: string): Promise<boolean>;

  // Status + pinned
  getStatus(): Promise<StatusInfo>;
  getPinned(): Promise<PinnedEntry[]>;
  setPinned(paths: string[]): Promise<string[]>;

  // Git
  getGitInfo(projectPath: string): Promise<GitInfo | null>;
  watchGit(projectPath: string | null): Promise<true>;
  getGitDiff(projectPath: string): Promise<DiffResult>;
  syncGit(projectPath: string): Promise<GitSyncResult>;
  pullGit(projectPath: string): Promise<GitSyncResult>;
  listBranches(projectPath: string): Promise<BranchRef[]>;
  checkoutBranch(projectPath: string, ref: BranchCheckoutRef): Promise<CheckoutResult>;
  addWorktree(baseProject: string, sessionId: string): Promise<WorktreeView>;
  removeWorktree(baseProject: string, sessionId: string): Promise<void>;
  /**
   * Full teardown: worktree AND session branch. Only for a pane closed with
   * ZERO activity — any activity goes through removeWorktree so the branch
   * survives for the S-3 F2.2 recovery chain.
   */
  cleanupWorktree(baseProject: string, sessionId: string): Promise<void>;
  listWorktrees(baseProject: string): Promise<WorktreeListItem[]>;

  // Project tree — file explorer with per-entry git status. Always lazy:
  // call once per folder as the user expands branches. `subPath` is empty
  // (or omitted) for the project root. `force` bypasses the per-project
  // cached git snapshot — pass true when reacting to events that may have
  // changed file status (process:end, manual refresh).
  listProjectTree(
    projectName: string,
    subPath?: string,
    force?: boolean,
  ): Promise<ProjectTreeResult>;

  // Compose
  /** `composeFile` (project-relative) targets a nested compose file found
   *  via search; omitted → docker resolves the project-root file. */
  runCompose(project: string, action: ComposeAction, composeFile?: string): void;
  /** Probe whether `docker compose` is available on the host. Called at
   *  startup so the right-rail Docker panel only shows when usable. */
  dockerDetect(): Promise<{ available: boolean }>;
  /** Whether the project has a compose file at its root (gates run actions). */
  composeDetect(project: string): Promise<{ file: string | null }>;
  /** Deep-scan the project for compose files in subfolders. */
  composeSearch(project: string): Promise<{ files: string[] }>;

  // Clone
  cloneRepo(payload: CloneRequest): void;

  // Shell
  openPath(p: string): Promise<string>;
  revealInFolder(p: string): Promise<true>;
  /** Open `p` in `ideId`; when omitted the main process picks the first
   *  installed IDE (VS Code preferred). */
  openInIde(p: string, ideId?: IdeId): Promise<true>;
  /** IDEs detected on this machine, in catalog order. */
  listIdes(): Promise<IdeInfo[]>;

  /**
   * Opens `${DEVIA_SAAS_URL}/upgrade?feature=<feature>` in the user's
   * default browser (E-DSK-08 #258). The renderer is unaffected; the user
   * completes payment on the saas web and the next entitlement heartbeat
   * picks up the new plan.
   */
  openUpgrade(feature: string): Promise<void>;

  // Titlebar / custom window controls.
  minimizeWindow(): Promise<boolean>;
  toggleMaximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<boolean>;
  isWindowMaximized(): Promise<boolean>;

  // Voice
  transcribe(buffer: ArrayBuffer): Promise<{ text?: string; error?: string }>;

  // Integrated terminal — one PTY per project, survives panel hide/show.
  // `start` is idempotent: if the project already has a live PTY it is
  // returned with `reused: true` so the renderer can decide whether to
  // clear its xterm buffer or just resubscribe to the live stream.
  terminalStart(project: string, size: TerminalSize): Promise<TerminalStartResult>;
  terminalWrite(project: string, data: string): void;
  terminalResize(project: string, size: TerminalSize): void;
  terminalStop(project: string): Promise<boolean>;

  // Skills manager — wraps `npx skills` for install/remove and scans the
  // agent-specific skill directories under the project and the user home.
  // `discoverSkills` performs a shallow clone into a temp dir and lists the
  // SKILL.md files inside so the renderer can show a multi-select picker
  // before committing to install.
  listSkills(project: string): Promise<ListSkillsResult>;
  installSkills(req: InstallSkillsRequest): Promise<SkillsRunResult>;
  removeSkill(req: RemoveSkillRequest): Promise<SkillsRunResult>;
  discoverSkills(req: DiscoverSkillsRequest): Promise<DiscoverSkillsResult>;
  cancelSkillDiscovery(discoveryId: string): Promise<{ ok: boolean }>;

  // CLI adapters
  listAgents(): Promise<DetectedAgentView[]>;
  /**
   * Persist the user's active CLI choice. The result now includes an
   * `accepted` flag and an optional `rejectedReason`: the SelectAgentUseCase
   * refuses to switch to non-executable providers (api / mcp / local-model
   * / planned) and the renderer surfaces the reason in the Settings modal.
   */
  selectAgent(agentId: string): Promise<{ agentId: string; accepted: boolean; rejectedReason?: string }>;
  setAgentModel(input: SetAgentModelInput): Promise<{ model?: string; reasoning?: string }>;
  setAgentEnv(input: SetAgentEnvInput): Promise<Record<string, string>>;
  /** REV-TS-CLI-13-03: returns full DetectedAgentView (incl. authStatus, diagnostic,
   *  resolvedBin) instead of the minimal TestAgentResult. */
  testAgent(agentId: string): Promise<DetectedAgentView>;

  // Event subscriptions
  onClaudeOutput(cb: (e: ClaudeOutputEvent) => void): void;
  onProcessStart(cb: (e: ProcessStartEvent) => void): void;
  /** S-2 F3.1: cross-agent session handoff notification. */
  onSessionHandoff(cb: (e: SessionHandoffEvent) => void): void;
  /** E-DSK-14: a session reset was triggered from Telegram (`/clean`); the
   *  renderer must clear the visible thread itself. */
  onSessionReset(cb: (e: SessionResetEvent) => void): void;
  /** The run hit the account's usage limit; Devia will continue it at `fireAt`. */
  onAutoResumeScheduled(cb: (e: AutoResumeScheduledEvent) => void): void;
  onAutoResumeCancelled(cb: (e: AutoResumeCancelledEvent) => void): void;
  /** Cancel the pending automatic resume of a session. */
  cancelAutoResume(project: string): Promise<void>;
  onProcessEnd(cb: (e: ProcessEndEvent) => void): void;
  onComposeStart(cb: (e: ComposeStartEvent) => void): void;
  onComposeOutput(cb: (e: ComposeOutputEvent) => void): void;
  onComposeEnd(cb: (e: ComposeEndEvent) => void): void;
  onOutboxFile(cb: (f: OutboxFile) => void): void;
  onCloneStart(cb: (e: CloneStartEvent) => void): void;
  onCloneOutput(cb: (e: CloneOutputEvent) => void): void;
  onCloneEnd(cb: (e: CloneEndEvent) => void): void;
  onGitInfoChanged(cb: (e: GitInfoChangedEvent) => void): void;
  onConfigChanged(cb: (cfg: DeviaConfigView) => void): void;
  onNotificationClick(cb: (e: NotificationClickEvent) => void): void;
  onAgentChanged(cb: (e: AgentChangedEvent) => void): void;
  onQueueChanged(cb: (e: QueueChangedEvent) => void): void;
  onQueueDispatched(cb: (e: QueueDispatchedEvent) => void): void;
  onTerminalData(cb: (e: TerminalDataEvent) => void): void;
  onTerminalExit(cb: (e: TerminalExitEvent) => void): void;

  // AskUserQuestion multi-turn protocol (TS-CLI-05)
  onQuestionAsk(cb: (e: QuestionAskEvent) => void): void;
  questionAnswer(project: string, toolUseId: string, answer: string): Promise<void>;

  // devia-ui interface tools (S-25)
  onUiToolRequest(cb: (e: UiToolRequestEvent) => void): void;
  sendUiToolResult(project: string, callId: string, answer: string): Promise<void>;
  listUiToolCatalog(): Promise<import('../domain/ui-tools').UiToolCatalogEntry[]>;
  listUiToolGrants(project: string): Promise<import('../domain/ui-tools').ConfirmationGrant[]>;
  /** Omit `action` to revoke every grant of the project. */
  revokeUiToolGrant(project: string, action?: string): Promise<void>;

  // Inline diff snapshots for file-editing tool results (TS-CLI-10)
  onDiffSnapshot(cb: (e: DiffSnapshotEvent) => void): void;

  // Agent detection push — fired once at startup when the main process finishes
  // probing all installed CLI agents. The renderer uses this to populate the
  // agent cache and release the splash screen without a subsequent agents:list call.
  onAgentsDetected(cb: (e: AgentsDetectedEvent) => void): void;

  // Security audit log (TS-CLI-12 Phase 4)
  readAuditLog(n: number): Promise<AuditEntry[]>;

  /** Running app version (= release tag at build time). Drives the footer. */
  getAppVersion(): Promise<string>;

  // Devia SaaS — baked-at-boot baseUrl resolved from `process.env.DEVIA_SAAS_URL`
  // by the main process. Exposed as a namespaced sub-object so future saas
  // helpers (paywall deep links, IDP probes) can slot in next to it without
  // polluting the top-level bridge surface (ticket #251).
  readonly saas: {
    /** The devia-saas web origin. Stable for the lifetime of the app. */
    baseUrl(): Promise<string>;
  };

  /**
   * Skill registry (#269). Generates and exposes the per-project
   * `.devia/skill-registry.md` index so the renderer can show a
   * "Skills (N)" counter and let the user open the file in a viewer
   * dialog. Refresh fires on project switch, after install/remove,
   * and on debounced fs.watch of every supported skill root.
   */
  readonly skillRegistry: {
    /** Read the current snapshot for the given project, refreshing
     *  the on-disk file if any skill root changed since last call.
     *  Returns null when the project path is empty. */
    status(projectPath: string): Promise<SkillRegistrySnapshot | null>;
    /** Force a regeneration of the registry. Used by the "Regenerar
     *  índice" entry inside the skills modal kebab when the user
     *  knows they touched skills outside devia. */
    refresh(projectPath: string): Promise<SkillRegistryRefreshResult>;
    /** Attach the watcher to a project (or detach with `null`). The
     *  main process keeps one watcher per project; calling with the
     *  same path is idempotent. */
    watch(projectPath: string | null): Promise<true>;
    /** Subscribe to streaming refresh events. */
    onChanged(cb: (e: SkillRegistryChangedEvent) => void): void;
    /** Read the rendered Markdown body so the renderer can show it
     *  in the existing SpecViewer dialog. Returns null when the file
     *  doesn't exist (empty project). */
    read(projectPath: string): Promise<string | null>;
  };

  /**
   * Config snapshot + rollback (#270). Every destructive operation
   * across features (skill install/remove, MCP register, prompt-pack
   * inject, spec-kit init) captures the affected config files BEFORE
   * the write so the user can undo a bad change in one click.
   *
   * Snapshots are created from the main process side (each feature's
   * use case calls `SnapshotCreateUseCase` directly). The renderer
   * only consumes the read-side surface below to render the history
   * modal and the per-feature "Deshacer" toast.
   */
  readonly snapshot: {
    /** Last N snapshots, newest first. Filter by feature / project
     *  when set. Default limit 50. */
    list(query?: ListSnapshotsQuery): Promise<SnapshotSummary[]>;
    /** Restore a snapshot by feature + id. `safe=true` opts into the
     *  drift guard — files whose current sha differs from the captured
     *  one are reported under `result.drift` instead of being
     *  overwritten. Default behaviour (no flag) overwrites
     *  unconditionally because snapshots are the authoritative ground
     *  truth for undo. */
    restore(
      feature: SnapshotFeature,
      id: string,
      options?: { safe?: boolean },
    ): Promise<SnapshotRestoreResult>;
    /** Toggle the pin flag — pinned snapshots are exempt from the
     *  retention sweep (default 10 per feature, 30 days max age). */
    pin(feature: SnapshotFeature, id: string, pinned: boolean): Promise<true>;
    /** Permanently delete a snapshot. */
    delete(feature: SnapshotFeature, id: string): Promise<true>;
  };

  /**
   * MCP server management (#272/273/274). Lets the user install/
   * remove/probe MCP servers from a UI instead of hand-editing
   * `~/.devia-app/mcp-servers.json`. The main process materialises
   * each selected server into the matching agent's native config
   * file via marker-based merging (`__devia_managed` JSON key /
   * `# devia-mcp-start/end` TOML comments).
   *
   * Read side (`list`, `onChanged`) is always available; mutations
   * are guarded server-side by the same path/command sanitiser the
   * legacy loader already used.
   */
  readonly mcp: {
    /** Catalog snapshot (env values redacted). */
    list(): Promise<McpServerView[]>;
    /** Streaming refresh — fired after every install / remove / sync.
     *  Returns an unsubscribe so transient consumers (modals, per-message
     *  cards) can release the listener and avoid the EventEmitter leak. */
    onListChanged(cb: (servers: McpServerView[]) => void): () => void;
    /** Add (or update) a server and synchronise to its target agents. */
    install(req: {
      id: string;
      name: string;
      description?: string;
      command: string;
      args: string[];
      env?: Record<string, string>;
      allowedEnvKeys?: string[];
      agents: McpAgentId[];
      scope: McpScope;
      source: McpSource;
      projectPath?: string;
      enabled?: boolean;
    }): Promise<McpInstallResult>;
    /** Drop a server from the catalog + every agent file it lived in. */
    remove(id: string, projectPath?: string): Promise<McpInstallResult>;
    /** Re-apply the full catalog to every agent file. Useful after
     *  the user hand-edited an agent file and wants Devia-managed
     *  state restored. */
    sync(scope?: McpScope, projectPath?: string): Promise<McpInstallResult>;
    /** Spawn the server with an `initialize` request to check it
     *  actually starts. Caps at 5 s. */
    probe(id: string): Promise<McpProbeResult>;
  };

  /**
   * Cross-CLI sub-agent manager (#275). Devia owns a per-project
   * catalog at `<project>/.devia/sub-agents/<name>.md` and the
   * synchroniser materialises each entry into every selected CLI's
   * native location (`.claude/agents/`, `.cursor/agents/`,
   * `opencode.json`, `.qwen/commands/`, …).
   */
  readonly subAgents: {
    /** Catalog snapshot for the given project. */
    list(projectPath: string): Promise<SubAgentView[]>;
    /** Streamed when the project's catalog changes. */
    onChanged(cb: (e: {
      projectPath: string;
      subAgents: SubAgentView[];
    }) => void): void;
    /** Upsert a sub-agent into the project + sync to selected CLIs. */
    install(projectPath: string, entry: Omit<SubAgent, 'agents'> & {
      agents: SubAgentCliId[];
    }): Promise<SubAgentInstallResult>;
    /** Drop a sub-agent from the project + every CLI it lived in. */
    remove(projectPath: string, name: string): Promise<SubAgentInstallResult>;
    /** First-open import: scans native dirs for pre-existing
     *  sub-agents and copies them into `.devia/sub-agents/`. One-shot
     *  per project via a sentinel file. */
    autoImport(projectPath: string): Promise<SubAgentImportResult>;
  };

  /**
   * Devia-native SDD (E-DSK-12). Spec-driven development whose state
   * lives in devia's per-project cache, never in the user's repo.
   *
   * Flow: classification is driven by a persisted `newProject` flag
   * (set at "+"-creation, flipped false once spec/conversation starts).
   * The bootstrap modal just asks the user's intent and dispatches
   * `init` (new) or `prepare` (existing); both return an agent
   * instruction the renderer sends through the normal chat path. The
   * agent then drives the kanban board via the bundled
   * devia-kanban MCP server, and the UI mutates it through the
   * `kanban*` methods. All board changes stream via `onKanbanChanged`.
   */
  readonly sdd: {
    /** T2 — classify the project. `force` re-runs even if already
     *  bootstrapped (used by a manual "reconfigure" action). */
    bootstrap(projectPath: string, force?: boolean): Promise<BootstrapView>;
    /** T3 — existing project: returns the analyse + guidance + seed
     *  prompt and marks the project bootstrapped. */
    prepare(projectPath: string): Promise<SddPromptResult>;
    /** T9 — new project: creates the seed spec from the user's intent
     *  and returns the backlog-expansion prompt. */
    init(projectPath: string, intent: string, title?: string): Promise<SddPromptResult>;
    /** Record a project at "+"-creation time, persisting the
     *  `newProject` flag (blank/base → new, import → existing) without
     *  seeding the board. Used by the unified "Nuevo proyecto" modal's
     *  "Crear" action. */
    markHandled(projectPath: string, classification: ProjectClassification): Promise<boolean>;
    /** Flip `newProject` to false once a conversation has started, so a
     *  later "Preparar proyecto" treats the project as existing. */
    markEngaged(projectPath: string): Promise<boolean>;

    // Kanban board (T4/T6)
    board(projectPath: string): Promise<KanbanBoardView>;
    task(projectPath: string, taskId: string): Promise<KanbanTaskView | null>;
    /** Returns the new task id, or null when the workspace is unset. */
    createTask(
      projectPath: string,
      specId: string,
      title: string,
      body?: string,
      dependsOn?: string[],
    ): Promise<string | null>;
    updateTask(
      projectPath: string,
      taskId: string,
      fields: { title?: string; body?: string; dueDate?: string; dependsOn?: string[]; sortIndex?: number; specId?: string },
    ): Promise<boolean>;
    moveTask(projectPath: string, taskId: string, column: KanbanColumn): Promise<boolean>;
    closeTask(projectPath: string, taskId: string, commit?: string): Promise<boolean>;
    /** Permanently remove a task from the board and strip any dangling
     *  references to it from other tasks. Returns false when not found. */
    deleteTask(projectPath: string, taskId: string): Promise<boolean>;
    /** Logical-delete (archive) a spec: hidden from the board view and the
     *  MCP tools but kept on disk (reopen is MCP-only). Refuses while the
     *  spec still has open (non-`done`) tasks unless `force` is set. Returns
     *  true when archived. */
    archiveSpec(projectPath: string, specId: string, force?: boolean): Promise<boolean>;
    blockTask(projectPath: string, taskId: string, reason: BlockReason, target?: string): Promise<boolean>;
    unblockTask(projectPath: string, taskId: string, resolution?: string): Promise<boolean>;
    /** Post a user message to a task thread; unblocks a user-blocked
     *  task and wakes the agent. */
    comment(projectPath: string, taskId: string, body: string): Promise<boolean>;
    /** Mark every agent message in a task thread as read. */
    markTaskRead(projectPath: string, taskId: string): Promise<void>;
    /** Streamed after every board mutation (UI, agent or MCP server). */
    onKanbanChanged(cb: (e: KanbanChangedEvent) => void): void;
    /** Streamed when a task (re)enters in_progress and the agent
     *  should be (re-)invoked. The renderer auto-dispatches the
     *  carried prompt for `started` / `user_reply`. */
    onAgentWake(cb: (e: KanbanAgentWakeEvent) => void): void;

    // Notification centre (T7)
    notifications(projectPath?: string): Promise<SddNotification[]>;
    markNotificationsRead(projectPath?: string): Promise<void>;
    clearNotifications(projectPath?: string): Promise<void>;
    onNotification(cb: (e: SddNotificationEvent) => void): void;
    /** Raise a native OS notification with already-localised text. The
     *  renderer owns i18n, so it builds the strings and asks the main
     *  process to show the native notification. */
    notifyOs(title: string, body: string): Promise<void>;
  };

  /**
   * Devia internal memory (S-1). Devia ships its own memory store + the
   * `devia-memory` MCP server; this namespace covers detecting an external
   * `engram` install, importing its memory once, and reading Devia's own
   * memory for a future management UI.
   */
  readonly memory: {
    /** Detect whether engram is installed (binary on PATH and/or its DB). */
    detectEngram(): Promise<EngramDetectionResult>;
    /** One-shot import of engram's memory into Devia's personal store via
     *  `engram export`. Marks `config.memory.engramImported` on success. */
    importEngram(): Promise<ImportEngramResult>;
    /** Lexical search over Devia's own memory observations. */
    search(query: MemorySearchQuery & { projectPath?: string }): Promise<MemorySearchHit[]>;
    /** Recent active observations for a scope/project (empty-query search). */
    list(opts?: { scope?: MemoryScope; projectPath?: string; project?: string; limit?: number }): Promise<Observation[]>;
    /** Recent session summaries for a scope/project (newest first). The bulk of
     *  a project's memory is auto-captured run summaries, not observations, so
     *  the management panel shows these as the "history". */
    listSessions(opts?: { scope?: MemoryScope; projectPath?: string; project?: string; limit?: number }): Promise<MemorySession[]>;
    /** Toggle the pinned flag on an observation (E-DSK-13 #320). Returns the
     *  updated observation, or undefined when not found / already deleted. */
    setPinned(args: { id: string; pinned: boolean; scope?: MemoryScope; projectPath?: string }): Promise<Observation | undefined>;
    /** Soft-delete an observation from the management panel (E-DSK-13 #320). */
    forget(args: { id: string; scope?: MemoryScope; projectPath?: string }): Promise<boolean>;
    /** Wipe an entire memory scope (E-DSK-13 #320). Defaults to personal. */
    clear(args?: { scope?: MemoryScope; projectPath?: string }): Promise<boolean>;
  };

  /**
   * Remote control (E-DSK-14). An embedded controller in the main process lets
   * the app be driven from a messaging platform (Telegram today) while it is
   * open. The renderer only configures it (token + chat id live in
   * `config.remoteControl`) and observes connection status; the controller
   * itself drives the same run/project use cases the UI does.
   */
  readonly remoteControl: {
    /** Current connection status of the remote-control subsystem. */
    getStatus(): Promise<RemoteControlStatus>;
    /** Validate a bot token (Telegram getMe) without enabling it. */
    test(botToken: string): Promise<TelegramTestResult>;
    /** Re-read config and (re)start or stop the controller; returns the new status. */
    restart(): Promise<RemoteControlStatus>;
    /** Subscribe to connection-status changes. */
    onStatus(cb: (s: RemoteControlStatus) => void): void;
    /** The controller asked the app to switch to a project (Telegram `/use`). */
    onSelectProject(cb: (e: RemoteSelectProjectEvent) => void): void;
  };

  /**
   * Run mode per session. Main owns the value (so Telegram and the app share
   * it); the renderer mirrors it and pushes its own changes with `set`.
   */
  readonly runMode: {
    /** The desktop changed a session's mode. */
    set(project: string, mode: RunModeChangedEvent['mode']): Promise<void>;
    /** Every session's current mode (non-default only), to hydrate on load. */
    getAll(): Promise<RunModeChangedEvent[]>;
    /** A mode changed in main (Telegram `/mode`, a keyword, a session reset). */
    onChanged(cb: (e: RunModeChangedEvent) => void): void;
  };

  /**
   * Auto-update. electron-updater (main process) reads published releases from
   * the public GitHub repo `dherrero/devia`, downloads in the background and
   * installs on restart. The renderer only observes progress and may trigger a
   * manual check or the restart-to-install.
   */
  readonly update: {
    /** Trigger a manual update check (no-op in dev / unpackaged builds). */
    check(): Promise<void>;
    /** Quit and install a downloaded update, relaunching the app. */
    install(): Promise<void>;
    /** Subscribe to update lifecycle status changes. */
    onStatus(cb: (s: UpdateStatus) => void): void;
  };
}
