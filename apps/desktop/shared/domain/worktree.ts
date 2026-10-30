/**
 * Serialisable view types for git worktrees. Declared in shared/ so both the
 * IPC handlers (src-main) and the renderer can reference them without
 * importing from each other's boundary.
 *
 * These are projections of the internal WorktreeRef / WorktreeInfo; the
 * handlers map internal types → these before returning over IPC.
 */

/** Returned by the `git:worktree-add` handler — the freshly created worktree. */
export interface WorktreeView {
  sessionId: string;
  worktreeDir: string;
  branch: string;
}

/** One entry returned by the `git:worktree-list` handler. */
export interface WorktreeListItem {
  worktreeDir: string;
  /** Absent on a bare worktree. */
  branch?: string;
  /** Absent on a fresh worktree that has no commits yet. */
  head?: string;
}
