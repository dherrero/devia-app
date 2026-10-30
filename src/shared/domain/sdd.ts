/**
 * Devia-native SDD shared domain (E-DSK-12).
 *
 * Cross-process types for first-contact bootstrap (T2), spec
 * preparation (T3) / initialisation (T9), and the notification
 * centre (T7). Kanban board types live in `./kanban`.
 *
 * No Node.js / Electron imports — this module is consumed by both
 * the main process and the Angular renderer.
 */

export type ProjectClassification = 'new' | 'existing';

/**
 * Outcome of the first-contact detection (T2 / SDD-F1).
 *
 * Classification is driven by a persisted `newProject` flag — the
 * single source of truth — not by a commit-count heuristic. The flag
 * is set true when a project is created with "+" (blank/base) and
 * flipped false once the spec or a conversation starts. The renderer
 * never shows a "new vs existing" chooser any more; it just asks the
 * user what they have in mind and routes init / prepare from this.
 */
export interface BootstrapView {
  readonly classification: ProjectClassification;
  /** True when devia ran `git init` because the repo was absent. */
  readonly gitInitialised: boolean;
  /** True when devia already saw this project — caller skips the modal. */
  readonly alreadyBootstrapped: boolean;
}

/**
 * A prompt the main process built for the active agent to execute
 * (prepare / init). The renderer dispatches `prompt` through the
 * normal `sendInstruction` path so chat history, streaming and
 * session persistence stay in one place.
 */
export interface SddPromptResult {
  /** Instruction text to dispatch via `sendInstruction`. */
  readonly prompt: string;
  /** Spec created as part of the flow (init), when applicable. */
  readonly specId?: string;
  /** Run mode the dispatch should use (prepare/init run in PLAN mode). */
  readonly mode: 'apply' | 'plan';
}

// ─── notifications (T7) ───────────────────────────────────────────

export type SddNotificationKind =
  | 'user_input'
  | 'task_done'
  | 'task_blocked'
  | 'unblocked'
  | 'dependency_resolved';

export interface SddNotification {
  readonly id: string;
  readonly projectPath: string;
  readonly kind: SddNotificationKind;
  /** Task this notification is about. The renderer builds the display
   *  text from `kind` (via i18n) + this data — the main process never
   *  emits localised strings. */
  readonly taskId?: string;
  readonly taskTitle?: string;
  readonly createdAt: number;
  read: boolean;
}

/** Streamed to the renderer when a new notification is raised (T7). */
export interface SddNotificationEvent {
  readonly projectPath: string;
  readonly notification: SddNotification;
  /** Unread count across all projects after this one was added. */
  readonly unreadTotal: number;
}

export function isProjectClassification(v: unknown): v is ProjectClassification {
  return v === 'new' || v === 'existing';
}
