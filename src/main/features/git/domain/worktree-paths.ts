import * as path from 'node:path';
import { projectKey } from '../../../shared/project-key';

/**
 * Returns the deterministic worktree directory for a session.
 *
 * Layout: <deviaDir>/worktrees/<projectKey>/<sessionId>/
 *
 * The projectKey sanitisation is shared with FsSessionStore so both subsystems
 * produce consistent per-project directory names for the same base path.
 */
export function worktreeDir(deviaDir: string, baseProject: string, sessionId: string): string {
  return path.join(deviaDir, 'worktrees', projectKey(baseProject), sessionId);
}

/**
 * Returns the deterministic git branch name for a session.
 *
 * Format: devia/session-<first-8-chars-of-sessionId>
 *
 * The 8-char prefix keeps refs short and human-readable while remaining
 * collision-resistant enough for the concurrent-session counts Devia targets.
 * The prefix `devia/` namespaces the branches in the repository browser.
 */
export function branchForSession(sessionId: string): string {
  return `devia/session-${sessionId.slice(0, 8)}`;
}
