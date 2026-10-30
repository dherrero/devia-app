import { worktreeDir, branchForSession } from './worktree-paths';

/**
 * Identity of a git worktree created for one concurrent session.
 *
 * Field names align with SessionRef { baseProject, sessionId, workdir, branch }
 * (T-145) so the two types compose without renaming: worktreeDir maps to
 * workdir when building a SessionRef for an additional session.
 */
export interface WorktreeRef {
  /** Absolute path to the canonical project checkout (no trailing slash). */
  baseProject: string;
  /** Stable session identifier (uuid). */
  sessionId: string;
  /** Absolute path to the git worktree directory for this session. */
  worktreeDir: string;
  /** Git branch checked out inside worktreeDir. */
  branch: string;
}

/**
 * Builds a fully-populated WorktreeRef from its inputs using the deterministic
 * path and branch helpers. The result is pure and reproducible: same inputs
 * always produce the same ref.
 */
export function worktreeRefFor(deviaDir: string, baseProject: string, sessionId: string): WorktreeRef {
  return {
    baseProject,
    sessionId,
    worktreeDir: worktreeDir(deviaDir, baseProject, sessionId),
    branch: branchForSession(sessionId),
  };
}
