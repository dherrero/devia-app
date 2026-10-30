/**
 * Per-project instruction queue.
 *
 * When the user sends a new instruction while the agent is already running
 * (or while the queue is paused with pending items), it is parked here
 * instead of being rejected. The runner pops the head when its current
 * process ends; manual reordering, editing, pausing and clearing all
 * happen via dedicated IPCs that ultimately mutate this structure.
 *
 * Items intentionally carry only the augmented text — attachments are
 * saved to disk at enqueue time and inlined into `text` via the same
 * `augmentInstruction` pipeline the inline send uses, so the queue file
 * never grows base64 buffers.
 */
export interface QueueItem {
  /** UUID assigned at enqueue time; stable for the lifetime of the item. */
  id: string;
  /** Final instruction text, already augmented with attachment notes. */
  text: string;
  /** Epoch ms — used for display ordering and "added X ago" tooltips. */
  createdAt: number;
  /**
   * What the user should SEE in the chat bubble when this item dispatches.
   * Set for system-built prompts (SDD planner, task wake) whose raw text is
   * an internal instruction — without it the renderer would print the whole
   * planner prompt as if the user typed it. Absent → show `text`.
   */
  displayText?: string;
  /** Run mode captured at enqueue time so a queued PLAN instruction is not
   *  silently dispatched in the default 'apply' mode. */
  mode?: 'plan' | 'apply' | 'apply-yolo';
  /** Where the instruction came from. Carried so a queued run dispatched later
   *  keeps its origin — a `'remote'` (Telegram) run must still get the remote
   *  system-prompt protocol + AskUserQuestion auto-answer. Omitted ⇒ renderer. */
  origin?: 'renderer' | 'remote';
  /**
   * Split-view run context (S-13 T-143). The queue is keyed by the session
   * IDENTITY (runKey), but dispatching needs the BASE project for cwd
   * resolution + the isolation flag + session id to recreate the same worktree.
   * Absent ⇒ the queue key IS the base project (primary / single pane).
   */
  baseProject?: string;
  runKey?: string;
  isolate?: boolean;
  sessionId?: string;
  /**
   * S-2 F3.4: run this item with a SPECIFIC agent instead of the configured
   * one (the "ask the previous agent for a handoff summary" flow). Carried on
   * queued items — same pattern as `origin` — so a parked request still runs
   * under the intended agent after the queue drains.
   */
  agentIdOverride?: string;
}

export interface ProjectQueueView {
  items: QueueItem[];
  paused: boolean;
}

export interface QueueChangedEvent {
  projectName: string;
  items: QueueItem[];
  paused: boolean;
}

/**
 * Emitted when the runner pops a queued item and actually starts running
 * it. Carries the instruction text so the renderer can append the user
 * bubble to the transcript at dispatch time — i.e. below the previous
 * agent response — instead of optimistically at enqueue time (which would
 * place it above). See QueueService.dispatchNext + the queue dispatch path
 * in claude.ipc.ts.
 */
export interface QueueDispatchedEvent {
  projectName: string;
  text: string;
  /** User-facing text for the bubble when `text` is an internal prompt. */
  displayText?: string;
}

export interface SendInstructionResult {
  /** True when the call was parked in the queue instead of running now. */
  queued: boolean;
  /** 1-indexed position in the queue when `queued === true`. */
  position?: number;
}
