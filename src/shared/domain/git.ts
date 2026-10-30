export interface GitInfo {
  branch: string;
  dirty: boolean;
  // Default branch of the repo (e.g. "main", "master", "develop"). Detected
  // from `refs/remotes/origin/HEAD`; `null` when there's no remote or the
  // ref hasn't been set yet (fresh `git init`). Drives the "sync" affordance:
  // the footer button only appears when on a non-default, clean branch.
  defaultBranch: string | null;
  /**
   * Commits the local branch is ahead / behind its upstream (HT-ST-02).
   * Both default to `0` when there is no upstream configured (fresh
   * branch never pushed) — keeps the statusbar's `↑ N` / `↓ N` arrows
   * absent rather than misleading.
   */
  ahead: number;
  behind: number;
  /**
   * Total number of changed entries (modified, added, deleted, renamed,
   * untracked) reported by `git status --porcelain`. Used by the
   * statusbar to render the "N cambios" pill alongside the dirty dot.
   * `0` when the working tree is clean (matches `dirty=false`).
   */
  changedCount: number;
}

export interface GitSyncResult {
  ok: boolean;
  branch?: string;
  message: string;
}

export type DiffLineType = 'add' | 'del' | 'context' | 'hunk';

export interface DiffLine {
  type: DiffLineType;
  oldLineNo?: number;
  newLineNo?: number;
  text: string;
}

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  lines: DiffLine[];
}

export interface DiffResult {
  hasChanges: boolean;
  files: DiffFile[];
  reason?: string;
}

/**
 * One branch entry surfaced by the footer branch switcher (S-22).
 * `name` is the user-facing ref name: a local branch is bare ("dev"),
 * a remote branch keeps its remote prefix ("origin/dev").
 */
export interface BranchRef {
  name: string;
  /** refs/remotes/* → true; refs/heads/* → false. */
  isRemote: boolean;
  /** The currently checked-out local branch (HEAD). Always false for remotes. */
  isCurrent: boolean;
  /** Short commit SHA of the branch tip. */
  shortSha: string;
  /** Local branch upstream short name (e.g. "origin/dev"); omitted when none. */
  upstream?: string;
  /** Commits ahead/behind the upstream; omitted when there is no upstream. */
  ahead?: number;
  behind?: number;
  /** Upstream ref deleted on remote ([gone]); omitted otherwise. */
  upstreamGone?: boolean;
  /** Last commit time, unix seconds. Drives the relative-date label + sort. */
  lastCommitTs: number;
  /** Last commit subject line. */
  subject: string;
}

/** Minimal ref the renderer sends back to request a checkout (S-22). */
export interface BranchCheckoutRef {
  name: string;
  isRemote: boolean;
}

/** Result of a branch checkout attempt (S-22). Mirrors GitSyncResult. */
export interface CheckoutResult {
  ok: boolean;
  /** Local branch actually checked out on success. */
  branch?: string;
  /** User-facing message (success summary or git stderr tail on failure). */
  message: string;
}
