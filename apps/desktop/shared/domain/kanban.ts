/**
 * Devia-native SDD kanban domain (E-DSK-12).
 *
 * Replaces the spec-kit integration with an internal SDD workflow.
 * State is process metadata, NOT product artifacts, so it lives in
 * devia's per-project cache (`~/.devia-app/projects/<key>/kanban.json`)
 * — never inside the user's repo.
 *
 * Storage note: the milestone proposed SQLite (`kanban.db`) but devia
 * stores everything as JSON under ~/.devia-app/ and the dual
 * WSL/Windows workflow makes native modules a cross-OS liability. We
 * use an atomically-written JSON document instead — the data per
 * project is small (specs + tasks + threads) and matches the existing
 * sessions/state/mcp persistence pattern.
 */

export type KanbanColumn =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'blocked'
  | 'done';

/** Reason a task sits in the `blocked` column. Drives the three
 *  sub-lanes (T6). */
export type BlockReason = 'dependency' | 'user' | 'subagent';

/** Author of a thread message. Sub-agents never post directly — the
 *  principal agent synthesises their output (T6). */
export type ThreadAuthor = 'user' | 'agent' | 'system';

export interface KanbanSpec {
  /** Internal id `S-<n>`. Stable across renames. */
  readonly id: string;
  title: string;
  description: string;
  readonly createdAt: number;
  /** Logical-delete timestamp. When set the spec is archived: hidden
   *  from the board view and the MCP tools by default, but kept on disk
   *  (reversible via `reopenSpec`). */
  archivedAt?: number;
}

export interface ThreadMessage {
  readonly id: string;
  readonly author: ThreadAuthor;
  /** For user/agent messages: the literal markdown content. For system
   *  messages (author === 'system'): an i18n KEY (e.g. `sdd.event.moved`)
   *  the renderer resolves with `| translate` — the main process never
   *  emits localised text. */
  readonly body: string;
  /** Interpolation params for the system-event i18n key (task ids,
   *  commit shas, sub-agent names — language-neutral data only). */
  readonly systemParams?: Record<string, string>;
  /** System-event kind, when author === 'system'. Drives the icon. */
  readonly systemEvent?:
    | 'blocked'
    | 'unblocked'
    | 'dep_resolved'
    | 'subagent_invoked'
    | 'subagent_returned'
    | 'moved'
    | 'commit_linked';
  readonly createdAt: number;
  /** Whether the user has read this message (drives the unread badge).
   *  System + user messages are always read; agent messages start
   *  unread. */
  read: boolean;
}

export interface SubagentInvocation {
  readonly id: string;
  readonly subagentName: string;
  readonly summary: string;
  readonly invokedAt: number;
  /** Set when the principal agent posts its synthesis comment. */
  returnedAt?: number;
}

export interface KanbanTask {
  /** Internal id `T-<n>`. Stable across renames. */
  readonly id: string;
  /** Owning spec id (S-n). Mutable: a task can be reassigned to another
   *  spec via `updateTask`. */
  specId: string;
  title: string;
  body: string;
  column: KanbanColumn;
  /** Column the task was in before being blocked — restored on
   *  unblock. */
  previousColumn?: KanbanColumn;
  blockReason?: BlockReason;
  /** For dependency blocks: the task id we wait on. For user blocks:
   *  the question text. For subagent blocks: the subagent name. */
  blockTarget?: string;
  /** Other task ids this task depends on (must be Done first). */
  dependsOn: string[];
  /** Priority order within a column (lower = higher). */
  sortIndex: number;
  /** Optional ISO date string. */
  dueDate?: string;
  /** Closing commit sha once Done (T10). */
  closingCommit?: string;
  /** Commit shas linked via the `Spec:` footer reverse-map (T10). */
  linkedCommits: string[];
  readonly thread: ThreadMessage[];
  readonly subagentLog: SubagentInvocation[];
  readonly createdAt: number;
  updatedAt: number;
}

/** Top-level document persisted at
 *  `~/.devia-app/projects/<key>/kanban.json`. */
export interface KanbanBoard {
  readonly version: 1;
  readonly projectPath: string;
  specs: KanbanSpec[];
  tasks: KanbanTask[];
  /** Monotonic counters for id minting. */
  nextSpecSeq: number;
  nextTaskSeq: number;
}

// ─── Renderer-facing views ────────────────────────────────────────

/** Lightweight card for column rendering. */
export interface KanbanCardView {
  readonly id: string;
  readonly specId: string;
  readonly title: string;
  readonly column: KanbanColumn;
  readonly blockReason?: BlockReason;
  readonly dependsOn: ReadonlyArray<string>;
  readonly sortIndex: number;
  readonly dueDate?: string;
  readonly unreadCount: number;
  readonly subagentNames: ReadonlyArray<string>;
  readonly hasCommit: boolean;
}

/** Full board snapshot for the renderer. */
export interface KanbanBoardView {
  readonly projectPath: string;
  readonly specs: ReadonlyArray<KanbanSpec>;
  readonly tasks: ReadonlyArray<KanbanCardView>;
}

/** Lightweight spec line with per-column task counts — the cheap answer
 *  to "what specs exist?" without dragging the whole board. */
export interface KanbanSpecSummary {
  readonly id: string;
  readonly title: string;
  readonly archived: boolean;
  readonly taskCounts: Readonly<Record<KanbanColumn, number>>;
  readonly totalTasks: number;
}

/** A card optionally carrying its full body (only in `verbose` listings). */
export type KanbanListCard = KanbanCardView & { readonly body?: string };

/** Paginated, filtered board listing returned by the `kanban_list` tool.
 *  Specs are always summaries; tasks default to lightweight cards (no
 *  body) and are paginated so a single query never dumps the whole
 *  board into the model's context. */
export interface KanbanListResult {
  readonly specs: ReadonlyArray<KanbanSpecSummary>;
  readonly tasks: ReadonlyArray<KanbanListCard>;
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

/** Options shared by the listing/summary store reads. */
export interface KanbanListOptions {
  readonly specId?: string;
  readonly column?: KanbanColumn;
  readonly includeArchived?: boolean;
  readonly verbose?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

/** Detailed task view (modal / right-pane). */
export interface KanbanTaskView {
  readonly id: string;
  readonly specId: string;
  readonly title: string;
  readonly body: string;
  readonly column: KanbanColumn;
  readonly blockReason?: BlockReason;
  readonly blockTarget?: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly dueDate?: string;
  readonly thread: ReadonlyArray<ThreadMessage>;
  readonly subagentLog: ReadonlyArray<SubagentInvocation>;
  readonly closingCommit?: string;
  readonly linkedCommits: ReadonlyArray<string>;
}

/** Streamed when any board mutation happens (UI + MCP both write). */
export interface KanbanChangedEvent {
  readonly projectPath: string;
  readonly board: KanbanBoardView;
}

/** Emitted when a task lands in blocked/user so the renderer can fire
 *  the notification (T7). */
export interface UserInputRequestEvent {
  readonly projectPath: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly question: string;
}

export type AgentWakeReason = 'started' | 'user_reply' | 'dependency_resolved';

/**
 * Emitted when a task (re)enters in_progress and the principal agent
 * should be invoked against it (T6). The main process pre-builds the
 * instruction; the renderer decides whether to auto-dispatch it
 * through the normal chat path (it does for `started` / `user_reply`,
 * and only notifies for `dependency_resolved`).
 */
export interface KanbanAgentWakeEvent {
  readonly projectPath: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly reason: AgentWakeReason;
  /** Instruction to dispatch via `sendInstruction`. */
  readonly prompt: string;
}

// ─── helpers ──────────────────────────────────────────────────────

export const KANBAN_COLUMNS: ReadonlyArray<KanbanColumn> = [
  'backlog', 'todo', 'in_progress', 'blocked', 'done',
];

export function isKanbanColumn(v: unknown): v is KanbanColumn {
  return typeof v === 'string' && (KANBAN_COLUMNS as ReadonlyArray<string>).includes(v);
}

export function isBlockReason(v: unknown): v is BlockReason {
  return v === 'dependency' || v === 'user' || v === 'subagent';
}
