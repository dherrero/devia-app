import type { DeviaConfigView } from '../domain/config';
import type { DiffFile, GitInfo } from '../domain/git';
import type { OutboxFile } from '../domain/attachment';
import type { ComposeAction } from '../domain/compose';
import type { AgentChangedEvent, DetectedAgentView, RunId } from '../domain/agent';
import type { QueueChangedEvent, QueueDispatchedEvent } from '../domain/queue';
import type { CancelReason, ErrorClassification } from '../domain/agent-event';
import type { FailoverReason } from '../domain/cli-errors';
import type { RemoteControlStatus } from '../domain/remote-control';
import type { UpdateStatus } from '../domain/update';
import type { UiToolName } from '../domain/ui-tools';

export interface ProcessStartEvent {
  project: string;
  /**
   * Branded UUID identifying this specific run. Carried on every subsequent
   * `claude:output` and `process:end` event so the renderer can correlate
   * events to the right assistant message even across concurrent runs.
   *
   * Optional for back-compat with persisted state that pre-dates REV-001.
   */
  runId?: RunId;
  /**
   * The agent id the main process actually used to spawn this run.
   * Stamping this on the event avoids a race where the renderer reads
   * config().agentId before the agent:changed IPC has arrived.
   */
  agentId?: string;
}

/**
 * Cross-agent session handoff (S-2 F3.1). Emitted at the start of a run that
 * continues a session another agent owned, BEFORE `process:start`, so the
 * renderer can persist a divider message ahead of the run's stream.
 * `project` is the run identity (runKey ?? projectPath), like every run event.
 */
export interface SessionHandoffEvent {
  project: string;
  fromAgentId: string;
  toAgentId: string;
  /** Rendered handoff brief (markdown) — becomes the divider message text. */
  summary: string;
  runId: RunId;
}

/**
 * Emitted by the main process when a session reset is triggered OUTSIDE the
 * renderer — i.e. the Telegram `/clean` command (E-DSK-14). The renderer owns
 * the in-memory chat + persistence, so it must clear the visible thread itself;
 * the reset use case only resets the main-process registry pointers.
 * `project` is the registry/session key (the primary pane's `SessionKey`).
 */
export interface SessionResetEvent {
  project: string;
}

/**
 * A run ended on the account's usage limit and Devia will continue the session
 * by itself at `fireAt` (epoch ms). `project` is the session identity.
 */
export interface AutoResumeScheduledEvent {
  project: string;
  fireAt: number;
}

/** The pending automatic resume of `project` is gone (it fired, or was cancelled). */
export interface AutoResumeCancelledEvent {
  project: string;
  reason: 'user' | 'stopped' | 'reset' | 'disabled' | 'replaced' | 'fired';
}

export interface ProcessEndEvent {
  project: string;
  /** Run identifier matching the originating `process:start`. */
  runId?: RunId;
  code: number | null;
  error?: string;
  /** Structured classification of the failure reason (TS-CLI-11). */
  classification?: ErrorClassification;
  /**
   * Recovery-action taxonomy from the new per-CLI matcher pipeline
   * (E-DSK-09 #262). The renderer branches on this to drive the right
   * UX path:
   *   - `auth_required` / `rotate_credential` → settings deep link
   *   - `quota_exceeded`                      → upgrade toast (#258)
   *   - `rate_limited`                        → cooldown indicator
   *
   * Carried in addition to (not in place of) the legacy
   * {@link classification} so existing consumers continue to work
   * during the migration window.
   */
  failoverReason?: FailoverReason;
  /** Optional renderer hint surfaced by the matcher (e.g. "Run `claude
   *  login`"). Only present when the matcher rule supplies one. */
  failoverHint?: string;
  /** Parsed `Retry-After` value in seconds, when the upstream API
   *  surfaces one (mostly 429 responses). */
  retryAfterSeconds?: number;
  /** OS signal that caused the process to exit (e.g. 'SIGTERM' for user cancellation). */
  signal?: string;
  /**
   * Structured cancellation cause (REV-AGENT-CORE-011). When set, the run was
   * deliberately terminated and the renderer should use a cancellation system
   * message rather than the generic error message.
   *   - 'user'             — user clicked Stop/Cancel.
   *   - 'idle'             — the launcher's 5-minute watchdog fired.
   *   - 'question_timeout' — AskUserQuestion went unanswered.
   */
  cancelReason?: CancelReason;
}

export interface ClaudeOutputEvent {
  project: string;
  /** Run identifier — events without a runId fall back to the project's latest active run. */
  runId?: RunId;
  line: string;
}

export interface ComposeStartEvent {
  project: string;
  action: ComposeAction;
}

export interface ComposeOutputEvent {
  project: string;
  action: ComposeAction;
  chunk: string;
}

export interface ComposeEndEvent {
  project: string;
  action: ComposeAction;
  code: number | null;
  error?: string;
}

export interface CloneStartEvent {
  repositoryUrl: string;
}

export interface CloneOutputEvent {
  line: string;
}

export interface CloneEndEvent {
  code: number;
  fullPath?: string;
  error?: string;
}

export interface GitInfoChangedEvent {
  projectPath: string;
  info: GitInfo | null;
}

export interface NotificationClickEvent {
  project: string;
}

/** Remote control asked the app to switch to a project (Telegram `/use`). */
export interface RemoteSelectProjectEvent {
  project: string;
}

export interface TerminalDataEvent {
  project: string;
  data: string;
}

export interface TerminalExitEvent {
  project: string;
  code: number;
  signal: number;
}

/**
 * Emitted by the main process when Claude's AskUserQuestion tool fires.
 * The renderer should surface this as an inline question card and submit
 * the user's reply via the `question:answer` IPC channel.
 */
/**
 * A single selectable answer surfaced by an AskUserQuestion tool call.
 * Extracted from the tool input so the renderer can render clickable pills
 * instead of forcing the user to retype an option verbatim.
 */
export interface QuestionOption {
  /** The text submitted back to the agent when this option is chosen. */
  label: string;
  /** Optional secondary line shown under the label. */
  description?: string;
}

export interface QuestionPrompt {
  id?: string;
  header?: string;
  question: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
}

export interface QuestionAskEvent {
  project: string;
  /** Run identifier — used to validate the answer goes to the right run. */
  runId?: RunId;
  toolUseId: string;
  question: string;
  /**
   * Discrete options the agent offered, when the tool input carried any.
   * Absent for free-form questions (the user types the answer) and for agents
   * whose AskUserQuestion payload has no options array.
   */
  options?: QuestionOption[];
  /**
   * Normalized full schema. Present when the tool input used the richer
   * `questions: [...]` shape or when callers want the renderer to preserve
   * headers / multi-select semantics.
   */
  questions?: QuestionPrompt[];
}

/**
 * A `devia-ui` tool the agent invoked, forwarded to the renderer so it can draw
 * the matching card (S-25). One event for every tool: the discriminator is
 * `tool`, exactly as it is in the on-disk rendezvous request.
 *
 * `question:ask` is NOT replaced by this — the S-24 question card keeps its own
 * channel so persisted transcripts and the existing renderer path are untouched.
 */
export interface UiToolRequestEvent {
  /** Run identity (runKey ?? projectPath), like every run event. */
  project: string;
  runId?: RunId;
  callId: string;
  tool: UiToolName;
  /** Already normalised in main with the `shared/domain/ui-tools` normalizers. */
  input: unknown;
  /** False for fire-and-forget tools: the card is informational, not answerable. */
  expectsAnswer: boolean;
}

/**
 * Emitted by the main process after a file-editing tool result (Edit, Write,
 * MultiEdit) when a git diff can be fetched. The renderer attaches the diff to
 * the matching ToolCallRecord. (TS-CLI-10)
 */
export interface DiffSnapshotEvent {
  project: string;
  /** Run identifier that produced the tool result this diff describes. */
  runId?: RunId;
  toolCallId: string;
  diff: DiffFile[];
}

/**
 * Emitted by the main process once agent detection completes at startup.
 * The renderer uses this to populate its agent cache and release the splash
 * screen without making a separate `agents:list` IPC call.
 */
export interface AgentsDetectedEvent {
  agents: DetectedAgentView[];
}

export type SkillRegistryChangedEvent = import('../domain/skill-registry').SkillRegistryChangedEvent;

/**
 * Map of every channel the main process emits to the renderer. The composition
 * root provides a typed `send<K extends keyof RendererEvents>` so an event
 * with the wrong payload shape fails at compile time.
 */
export interface RendererEvents {
  'process:start': ProcessStartEvent;
  'session:handoff': SessionHandoffEvent;
  'session:reset': SessionResetEvent;
  'autoresume:scheduled': AutoResumeScheduledEvent;
  'autoresume:cancelled': AutoResumeCancelledEvent;
  'process:end': ProcessEndEvent;
  'claude:output': ClaudeOutputEvent;
  'compose:start': ComposeStartEvent;
  'compose:output': ComposeOutputEvent;
  'compose:end': ComposeEndEvent;
  'clone:start': CloneStartEvent;
  'clone:output': CloneOutputEvent;
  'clone:end': CloneEndEvent;
  'outbox:file': OutboxFile;
  'git:info-changed': GitInfoChangedEvent;
  'config:changed': DeviaConfigView;
  'notification:click': NotificationClickEvent;
  'agent:changed': AgentChangedEvent;
  'queue:changed': QueueChangedEvent;
  'queue:dispatched': QueueDispatchedEvent;
  'terminal:data': TerminalDataEvent;
  'terminal:exit': TerminalExitEvent;
  'question:ask': QuestionAskEvent;
  'ui:tool-request': UiToolRequestEvent;
  'git:diff-snapshot': DiffSnapshotEvent;
  'agents:detected': AgentsDetectedEvent;
  'skillRegistry:changed': SkillRegistryChangedEvent;
  'mcp:list-changed': McpListChangedPayload;
  'subAgents:changed': SubAgentsChangedPayload;
  'kanban:changed': KanbanChangedPayload;
  'kanban:agent-wake': KanbanAgentWakePayload;
  'sdd:notification': SddNotificationPayload;
  'remoteControl:status': RemoteControlStatus;
  'remoteControl:select-project': RemoteSelectProjectEvent;
  'update:status': UpdateStatus;
}

export type McpListChangedPayload = import('../domain/mcp').McpListChangedEvent;
export type SubAgentsChangedPayload = import('../domain/sub-agents').SubAgentListChangedEvent;
export type KanbanChangedPayload = import('../domain/kanban').KanbanChangedEvent;
export type KanbanAgentWakePayload = import('../domain/kanban').KanbanAgentWakeEvent;
export type SddNotificationPayload = import('../domain/sdd').SddNotificationEvent;
