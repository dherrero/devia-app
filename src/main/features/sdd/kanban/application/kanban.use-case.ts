import * as crypto from 'node:crypto';

import type {
  BlockReason,
  KanbanBoard,
  KanbanColumn,
  KanbanSpec,
  KanbanTask,
  ThreadMessage,
} from '../../../../../shared/domain/kanban';
import { KanbanStore } from '../infrastructure/kanban-store';

/**
 * Kanban operations + block state machine (E-DSK-12 T4/T5/T6).
 *
 * Single source of truth for every board mutation, called by both
 * the renderer IPC adapter (UI actions) and the MCP server (agent
 * tool calls). The block model lives here:
 *
 *   backlog → todo → in_progress ⇄ blocked(dep|user|subagent) → done
 *
 * Resolution edges:
 *   blocked(dependency) — target task → done    → previous column
 *   blocked(user)       — user posts to thread   → in_progress
 *   blocked(subagent)   — agent posts synthesis  → in_progress
 *
 * Mutations return the result of an optional `onChange` callback so
 * the caller can broadcast `kanban:changed` to the renderer. The
 * callback is also where `request_user_input` fires the notification
 * (T7) — kept out of this pure-ish layer via the hook.
 */

export interface KanbanHooks {
  /** Fired after any board mutation. */
  onChange?(projectPath: string): void;
  /** Fired when a task lands in blocked/user — drives notifications. */
  onUserInputRequest?(projectPath: string, task: KanbanTask, question: string): void;
  /** Fired when the principal agent should be (re-)invoked against a
   *  task — drag into in_progress, user reply unblock, dep resolved.
   *  `wakeReason` shapes the re-entry system prompt (T6). */
  onAgentWake?(projectPath: string, task: KanbanTask, wakeReason: AgentWakeReason): void;
}

export type AgentWakeReason =
  | 'started'
  | 'user_reply'
  | 'dependency_resolved';

export class KanbanUseCase {
  constructor(
    private readonly store: KanbanStore,
    private readonly hooks: KanbanHooks = {},
  ) {}

  // ── specs ───────────────────────────────────────────────────────

  createSpec(projectPath: string, title: string, description: string): KanbanSpec {
    const board = this.store.load(projectPath);
    const spec: KanbanSpec = {
      id: `S-${board.nextSpecSeq}`,
      title: title.trim() || `Spec ${board.nextSpecSeq}`,
      description,
      createdAt: Date.now(),
    };
    board.specs.push(spec);
    board.nextSpecSeq += 1;
    this.commit(board);
    return spec;
  }

  /**
   * Logical-delete (archive) a spec: hidden from the board view and the
   * MCP tools by default, but kept on disk and reversible. Refuses while
   * the spec still has open (non-`done`) tasks unless `force` is set, so
   * a half-finished spec isn't hidden by accident. Returns the outcome so
   * the caller can surface why it was rejected.
   */
  archiveSpec(
    projectPath: string,
    specId: string,
    opts: { force?: boolean } = {},
  ): { ok: boolean; reason?: 'not_found' | 'already_archived' | 'open_tasks'; openTasks?: number } {
    const board = this.store.load(projectPath);
    const spec = board.specs.find((s) => s.id === specId);
    if (!spec) return { ok: false, reason: 'not_found' };
    if (spec.archivedAt !== undefined) return { ok: false, reason: 'already_archived' };
    const openTasks = board.tasks.filter((t) => t.specId === specId && t.column !== 'done').length;
    if (openTasks > 0 && opts.force !== true) {
      return { ok: false, reason: 'open_tasks', openTasks };
    }
    spec.archivedAt = Date.now();
    this.commit(board);
    return { ok: true, ...(openTasks > 0 && { openTasks }) };
  }

  /** Reverse `archiveSpec`: the spec reappears in the board and tools. */
  reopenSpec(projectPath: string, specId: string): boolean {
    const board = this.store.load(projectPath);
    const spec = board.specs.find((s) => s.id === specId);
    if (!spec || spec.archivedAt === undefined) return false;
    delete spec.archivedAt;
    this.commit(board);
    return true;
  }

  // ── tasks ───────────────────────────────────────────────────────

  createTask(
    projectPath: string,
    specId: string,
    title: string,
    body: string,
    dependsOn: string[] = [],
    opts: { column?: KanbanColumn } = {},
  ): KanbanTask {
    const board = this.store.load(projectPath);
    const now = Date.now();
    const validDeps = dependsOn.filter((d) => board.tasks.some((t) => t.id === d));
    // The planner seeds tasks straight into `todo`; everything else
    // defaults to the backlog. `in_progress`/`done` are not valid entry
    // columns (they would bypass the start gate), so they fall back.
    const requested = opts.column === 'todo' || opts.column === 'backlog' ? opts.column : 'backlog';
    const task: KanbanTask = {
      id: `T-${board.nextTaskSeq}`,
      specId,
      title: title.trim() || `Task ${board.nextTaskSeq}`,
      body,
      // A task with unmet deps starts blocked; otherwise the requested column.
      column: validDeps.length > 0 ? 'blocked' : requested,
      ...(validDeps.length > 0 && { blockReason: 'dependency' as BlockReason }),
      dependsOn: validDeps,
      sortIndex: board.tasks.length,
      linkedCommits: [],
      thread: [],
      subagentLog: [],
      createdAt: now,
      updatedAt: now,
    };
    if (validDeps.length > 0 && validDeps[0]) {
      // Resolve back into the column it was meant for (todo for the planner).
      task.previousColumn = requested;
      task.blockTarget = validDeps[0];
    }
    board.nextTaskSeq += 1;
    board.tasks.push(task);
    this.commit(board);
    return task;
  }

  /**
   * Edit a task's mutable fields. Editing `dependsOn` re-evaluates the
   * dependency block state (T-139): clearing the last unmet dependency
   * unblocks the task back to its previous column, and adding an unmet
   * dependency to a live task blocks it — mirroring `createTask`. A
   * `specId` that doesn't resolve to an existing spec is ignored (so a
   * typo never orphans the task). Self-references in `dependsOn` are
   * dropped.
   */
  updateTask(
    projectPath: string,
    taskId: string,
    fields: Partial<Pick<KanbanTask, 'title' | 'body' | 'dueDate' | 'dependsOn' | 'sortIndex' | 'specId'>>,
  ): KanbanTask | null {
    const board = this.store.load(projectPath);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    if (fields.title !== undefined) task.title = fields.title;
    if (fields.body !== undefined) task.body = fields.body;
    if (fields.dueDate !== undefined) task.dueDate = fields.dueDate;
    if (fields.specId !== undefined && board.specs.some((s) => s.id === fields.specId)) {
      task.specId = fields.specId;
    }
    let depsChanged = false;
    if (fields.dependsOn !== undefined) {
      task.dependsOn = fields.dependsOn.filter(
        (d) => d !== taskId && board.tasks.some((t) => t.id === d),
      );
      depsChanged = true;
    }
    if (fields.sortIndex !== undefined) task.sortIndex = fields.sortIndex;
    task.updatedAt = Date.now();
    if (depsChanged) this.reconcileDependencyBlock(board, task);
    this.commit(board);
    return task;
  }

  /**
   * Move a task to a column. Honours the state machine:
   *  - moving INTO in_progress fires onAgentWake('started').
   *  - moving to done is allowed from in_progress (or via drag with
   *    a recorded system event); from blocked the caller should
   *    unblock first — we still allow it but log a moved event.
   */
  moveTask(
    projectPath: string,
    taskId: string,
    to: KanbanColumn,
    opts: { viaUser?: boolean } = {},
  ): KanbanTask | null {
    const board = this.store.load(projectPath);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    const from = task.column;
    if (from === to) return task;

    task.column = to;
    if (to !== 'blocked') {
      delete task.blockReason;
      delete task.blockTarget;
    }
    task.updatedAt = Date.now();
    if (opts.viaUser) {
      this.pushSystem(task, 'moved', 'sdd.event.moved', { column: to });
    }
    this.commit(board);
    if (to === 'in_progress') {
      this.hooks.onAgentWake?.(projectPath, task, 'started');
    }
    return task;
  }

  closeTask(projectPath: string, taskId: string, commitRef?: string): KanbanTask | null {
    const board = this.store.load(projectPath);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    task.column = 'done';
    delete task.blockReason;
    delete task.blockTarget;
    if (commitRef) task.closingCommit = commitRef;
    task.updatedAt = Date.now();
    this.pushSystem(
      task,
      'moved',
      commitRef ? 'sdd.event.closed_commit' : 'sdd.event.closed',
      commitRef ? { commit: commitRef.slice(0, 8) } : undefined,
    );
    // Auto-resolve dependents waiting on this task.
    this.resolveDependents(board, taskId);
    this.commit(board);
    return task;
  }

  /**
   * Permanently remove a task. Strips its id from every other task's
   * `dependsOn` (and clears a `blockTarget` that pointed at it) so the
   * board never carries a dangling reference to a task that no longer
   * exists. User-initiated only — agents have no delete tool.
   */
  deleteTask(projectPath: string, taskId: string): boolean {
    const board = this.store.load(projectPath);
    const idx = board.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;
    board.tasks.splice(idx, 1);
    for (const t of board.tasks) {
      if (t.dependsOn.includes(taskId)) {
        t.dependsOn = t.dependsOn.filter((d) => d !== taskId);
      }
      if (t.blockTarget === taskId) delete t.blockTarget;
    }
    this.commit(board);
    return true;
  }

  // ── block / unblock (T6) ────────────────────────────────────────

  blockTask(
    projectPath: string,
    taskId: string,
    reason: BlockReason,
    target?: string,
  ): KanbanTask | null {
    const board = this.store.load(projectPath);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    if (task.column !== 'blocked') task.previousColumn = task.column;
    task.column = 'blocked';
    task.blockReason = reason;
    if (target !== undefined) task.blockTarget = target;
    task.updatedAt = Date.now();
    const blockedKey = reason === 'user'
      ? 'sdd.event.blocked_user'
      : reason === 'dependency'
        ? 'sdd.event.blocked_dependency'
        : 'sdd.event.blocked_subagent';
    // Only dependency/subagent carry a meaningful target (user's target is
    // the question text, which we don't echo in the system label).
    const blockedParams = reason !== 'user' && target ? { target } : undefined;
    this.pushSystem(task, 'blocked', blockedKey, blockedParams);
    this.commit(board);
    if (reason === 'user') {
      this.hooks.onUserInputRequest?.(projectPath, task, target ?? '');
    }
    return task;
  }

  unblockTask(projectPath: string, taskId: string, resolution?: string): KanbanTask | null {
    const board = this.store.load(projectPath);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    const back = task.previousColumn ?? 'in_progress';
    task.column = back;
    delete task.blockReason;
    delete task.blockTarget;
    delete task.previousColumn;
    task.updatedAt = Date.now();
    this.pushSystem(task, 'unblocked', 'sdd.event.unblocked', resolution ? { note: resolution } : undefined);
    this.commit(board);
    return task;
  }

  /** Sugar over blockTask(reason='user'). */
  requestUserInput(projectPath: string, taskId: string, question: string): KanbanTask | null {
    return this.blockTask(projectPath, taskId, 'user', question);
  }

  // ── communication ───────────────────────────────────────────────

  /**
   * Append a message to the thread. When the user posts to a task
   * blocked on `user`, the state machine unblocks it and wakes the
   * principal agent (T6).
   */
  comment(
    projectPath: string,
    taskId: string,
    author: 'user' | 'agent',
    body: string,
  ): KanbanTask | null {
    const board = this.store.load(projectPath);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    task.thread.push(message(author, body));
    task.updatedAt = Date.now();

    let wake: KanbanTask | null = null;
    if (author === 'user' && task.column === 'blocked' && task.blockReason === 'user') {
      task.column = task.previousColumn ?? 'in_progress';
      delete task.blockReason;
      delete task.blockTarget;
      delete task.previousColumn;
      this.pushSystem(task, 'unblocked', 'sdd.event.unblocked_user');
      wake = task;
    }
    // Agent comment while blocked on subagent = implicit unblock (T6).
    if (author === 'agent' && task.column === 'blocked' && task.blockReason === 'subagent') {
      // Close the open invocation log entry.
      const open = task.subagentLog.find((s) => s.returnedAt === undefined);
      if (open) open.returnedAt = Date.now();
      task.column = task.previousColumn ?? 'in_progress';
      delete task.blockReason;
      delete task.blockTarget;
      delete task.previousColumn;
      this.pushSystem(task, 'subagent_returned', 'sdd.event.subagent_returned');
    }
    this.commit(board);
    if (wake) this.hooks.onAgentWake?.(projectPath, task, 'user_reply');
    return task;
  }

  recordSubagentInvocation(
    projectPath: string,
    taskId: string,
    subagentName: string,
    summary: string,
  ): KanbanTask | null {
    const board = this.store.load(projectPath);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    task.subagentLog.push({
      id: rid(),
      subagentName,
      summary,
      invokedAt: Date.now(),
    });
    if (task.column !== 'blocked') task.previousColumn = task.column;
    task.column = 'blocked';
    task.blockReason = 'subagent';
    task.blockTarget = subagentName;
    task.updatedAt = Date.now();
    this.pushSystem(task, 'subagent_invoked', 'sdd.event.subagent_invoked', { name: subagentName });
    this.commit(board);
    return task;
  }

  /** Mark every agent message in a task's thread as read. */
  markThreadRead(projectPath: string, taskId: string): void {
    const board = this.store.load(projectPath);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return;
    let changed = false;
    for (const m of task.thread) {
      if (!m.read) { m.read = true; changed = true; }
    }
    if (changed) this.commit(board);
  }

  /** Link a commit to a task (T10 reverse-map). */
  linkCommit(projectPath: string, taskId: string, sha: string): KanbanTask | null {
    const board = this.store.load(projectPath);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    if (!task.linkedCommits.includes(sha)) {
      task.linkedCommits.push(sha);
      this.pushSystem(task, 'commit_linked', 'sdd.event.commit_linked', { commit: sha.slice(0, 8) });
      task.updatedAt = Date.now();
      this.commit(board);
    }
    return task;
  }

  /**
   * Fold a reverse-mapped {taskId → shas} set (T10) into the board in
   * a single write. Only links not already present are added; returns
   * the number of new links so the caller can skip the change event
   * when nothing moved.
   */
  syncCommitLinks(projectPath: string, byTask: Map<string, string[]>): number {
    const board = this.store.load(projectPath);
    let added = 0;
    for (const [taskId, shas] of byTask) {
      const task = board.tasks.find((t) => t.id === taskId);
      if (!task) continue;
      for (const sha of shas) {
        if (!task.linkedCommits.includes(sha)) {
          task.linkedCommits.push(sha);
          task.updatedAt = Date.now();
          added += 1;
        }
      }
    }
    if (added > 0) this.commit(board);
    return added;
  }

  // ── internals ───────────────────────────────────────────────────

  /**
   * Re-evaluate a task's dependency block after its `dependsOn` set
   * changed (T-139). Only touches dependency blocks — never a user/
   * subagent block. Two edges:
   *  - blocked(dependency) with all deps now met → unblock to previous
   *    column (the column it was heading for).
   *  - a live task (backlog/todo/in_progress) that gains an unmet dep →
   *    block it, mirroring `createTask`.
   */
  private reconcileDependencyBlock(board: KanbanBoard, task: KanbanTask): void {
    const unmet = task.dependsOn.filter(
      (d) => board.tasks.find((x) => x.id === d)?.column !== 'done',
    );
    const firstUnmet = unmet[0];
    if (task.column === 'blocked' && task.blockReason === 'dependency') {
      if (firstUnmet === undefined) {
        task.column = task.previousColumn ?? 'todo';
        delete task.blockReason;
        delete task.blockTarget;
        delete task.previousColumn;
        this.pushSystem(task, 'unblocked', 'sdd.event.unblocked');
      } else {
        task.blockTarget = firstUnmet;
      }
      return;
    }
    if (firstUnmet !== undefined && task.column !== 'blocked' && task.column !== 'done') {
      task.previousColumn = task.column;
      task.column = 'blocked';
      task.blockReason = 'dependency';
      task.blockTarget = firstUnmet;
      this.pushSystem(task, 'blocked', 'sdd.event.blocked_dependency', { target: firstUnmet });
    }
  }

  /** When `closedId` reaches Done, move dependents back to their
   *  previous column and wake the agent if they were running. */
  private resolveDependents(board: KanbanBoard, closedId: string): void {
    for (const t of board.tasks) {
      if (t.column !== 'blocked' || t.blockReason !== 'dependency') continue;
      if (!t.dependsOn.includes(closedId)) continue;
      // Only resolve when ALL deps are done.
      const allDone = t.dependsOn.every(
        (d) => board.tasks.find((x) => x.id === d)?.column === 'done',
      );
      if (!allDone) continue;
      t.column = t.previousColumn ?? 'todo';
      delete t.blockReason;
      delete t.blockTarget;
      delete t.previousColumn;
      t.updatedAt = Date.now();
      this.pushSystem(t, 'dep_resolved', 'sdd.event.dep_resolved', { dep: closedId });
      this.hooks.onAgentWake?.(board.projectPath, t, 'dependency_resolved');
    }
  }

  /** Push a system thread message. `key` is an i18n key (e.g.
   *  `sdd.event.moved`) and `params` are language-neutral interpolation
   *  values — the renderer localises them. The main process never emits
   *  translated text. */
  private pushSystem(
    task: KanbanTask,
    event: ThreadMessage['systemEvent'],
    key: string,
    params?: Record<string, string>,
  ): void {
    task.thread.push({
      id: rid(),
      author: 'system',
      body: key,
      ...(params !== undefined && { systemParams: params }),
      ...(event !== undefined && { systemEvent: event }),
      createdAt: Date.now(),
      read: true,
    });
  }

  private commit(board: KanbanBoard): void {
    this.store.save(board);
    this.hooks.onChange?.(board.projectPath);
  }
}

function message(author: 'user' | 'agent', body: string): ThreadMessage {
  return {
    id: rid(),
    author,
    body,
    createdAt: Date.now(),
    // Agent messages start unread (drive the badge); user messages are
    // self-authored so read immediately.
    read: author === 'user',
  };
}

function rid(): string {
  return crypto.randomBytes(6).toString('hex');
}
