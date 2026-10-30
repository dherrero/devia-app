/**
 * Session identity for multi-session / worktree support (S-13 T-145).
 *
 * Identity = working directory of the run ("worktreeDir-as-identity"):
 *   - Primary session  → workdir === projectPath  → key === projectPath
 *   - Extra sessions   → workdir === worktreeDir   → key === worktreeDir
 *
 * The backend is already keyed by path (registry Map<projectPath>, queue,
 * runningPaths, claude:output dispatch). This lets per-session isolation come
 * almost for free while leaving the single-pane case byte-for-byte identical
 * to the current behaviour — no keys change when only one session is open.
 */

/**
 * Canonical identity of one running (or potentially running) session.
 *
 * `workdir` is the actual filesystem directory the agent CLI will be launched
 * from. For the primary session it equals `baseProject`; for each additional
 * concurrent session of the same project it equals the git worktree directory
 * created for that session.
 *
 * Field names are aligned with `WorktreeRef { baseProject, sessionId,
 * worktreeDir, branch }` that T-150 introduces, so the two types compose
 * without renaming.
 */
export interface SessionRef {
  /** Absolute path to the canonical project checkout (no trailing slash). */
  baseProject: string;
  /**
   * Stable identifier for this panel/session (e.g. uuid). Unique per open
   * panel, persisted with the panel layout so re-opens restore the same key.
   */
  sessionId: string;
  /**
   * Absolute path to the directory the agent runs in.
   * Primary session: same as baseProject.
   * Additional sessions: the git worktree directory created for isolation.
   */
  workdir: string;
  /**
   * Git branch checked out inside `workdir`. Present only for additional
   * sessions (worktrees). Omitted for the primary session (uses whatever
   * branch is currently checked out in the repo).
   *
   * exactOptionalPropertyTypes: omit this field instead of setting undefined.
   */
  branch?: string;
}

/**
 * The single source of truth for the live-state key used by the renderer and
 * main process to identify a session's running state, output stream, queue
 * slot, and git watcher.
 *
 * Returns `ref.workdir` unconditionally. For the primary/single session,
 * `workdir === baseProject`, so the returned key is identical to the project
 * path that all existing code already uses — single-pane behaviour is
 * unchanged. For additional sessions, `workdir` is the worktree directory,
 * producing a distinct key that cannot collide with the primary session or
 * with other concurrent sessions on the same project.
 */
export function sessionKey(ref: SessionRef): string {
  return ref.workdir;
}

/**
 * Convenience constructor for the first (primary) session of a project.
 * workdir === baseProject so sessionKey returns the project path, matching
 * the existing single-session key contract exactly.
 */
export function primarySessionRef(baseProject: string, sessionId: string): SessionRef {
  return { baseProject, sessionId, workdir: baseProject };
}
