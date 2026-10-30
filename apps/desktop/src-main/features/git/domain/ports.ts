import type { GitInfo, GitSyncResult, BranchRef, BranchCheckoutRef, CheckoutResult } from '../../../../shared/domain/git';
import type { WorktreeRef } from './worktree-ref';

export type GitWatchListener = (payload: { projectPath: string; info: GitInfo | null }) => void;

/**
 * Write-side companion to `GitInspector`. Switches to the repo's default
 * branch and fast-forward-pulls. Mirrors the `sync` handler from the
 * agent-controler Telegram bot.
 */
export interface GitSyncer {
  sync(projectPath: string): Promise<GitSyncResult>;
  /**
   * Fast-forward pull of the CURRENT branch from its upstream (S-22 follow-up).
   * `git pull --ff-only` — never merges/rebases, so a diverged branch aborts
   * cleanly with git's message instead of creating a merge commit.
   */
  pull(projectPath: string): Promise<GitSyncResult>;
}

/**
 * S-22: lists branches (local + remote) and switches the base checkout.
 * Read + write side, consumed by the footer branch switcher.
 */
export interface GitBrancher {
  list(projectPath: string): Promise<BranchRef[]>;
  checkout(projectPath: string, ref: BranchCheckoutRef): Promise<CheckoutResult>;
}

/**
 * Reactive watcher for the currently active project. Watches a small set
 * of files inside `<project>/.git/` and emits debounced change notifications
 * with the latest `gitInfo()` snapshot. Single active project at a time:
 * `start()` replaces any previous watcher.
 */
export interface GitWatcher {
  start(projectPath: string, listener: GitWatchListener): void;
  stop(): void;
  /** Forces an immediate re-check of the active project, bypassing the
   *  debounce. Used by the main shell when the window regains focus. */
  refresh(): void;
}

// ---------------------------------------------------------------------------
// Worktree management
// ---------------------------------------------------------------------------

/** One entry from `git worktree list --porcelain`. */
export interface WorktreeInfo {
  worktreeDir: string;
  /** Absent on a bare worktree. */
  branch?: string;
  /** Absent on a fresh worktree that has no commits. */
  head?: string;
}

/**
 * Typed error codes consumed by T-153/T-154 to decide fallback behaviour.
 *
 * - `not-a-repo`      — `cwd` is not inside a git repository
 * - `no-commits`      — repo exists but HEAD is unborn (no initial commit)
 * - `branch-exists`   — `-b <branch>` target already exists in the repo
 * - `worktree-exists` — the destination path is already a registered worktree
 * - `unknown`         — any other git error (message preserved in `detail`)
 */
export type WorktreeErrorCode =
  | 'not-a-repo'
  | 'no-commits'
  | 'branch-exists'
  | 'worktree-exists'
  | 'unknown';

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  /** Raw git stderr/message, kept for logging — never forwarded over IPC. */
  readonly detail: string;

  constructor(code: WorktreeErrorCode, detail: string) {
    super(`worktree error [${code}]: ${detail}`);
    this.name = 'WorktreeError';
    this.code = code;
    this.detail = detail;
  }
}

export interface GitWorktreeManager {
  /**
   * Creates a new linked worktree at `ref.worktreeDir` on branch `ref.branch`.
   * @param baseRef Starting commit; defaults to `HEAD` when omitted.
   */
  add(ref: WorktreeRef, baseRef?: string): Promise<void>;
  /**
   * Removes the linked worktree at `ref.worktreeDir` (force) and prunes
   * stale administrative files.
   */
  remove(ref: WorktreeRef): Promise<void>;
  /** Lists all worktrees registered for the given base project path. */
  list(baseProject: string): Promise<WorktreeInfo[]>;
}
