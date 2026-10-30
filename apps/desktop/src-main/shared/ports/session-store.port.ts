import type { PersistedSession } from '../../../shared/domain/session';
import type { SessionStats } from '../../../shared/domain/session-stats';

/**
 * On-disk chat session persistence. Owned by the `sessions` feature.
 *
 * The renderer is the source of truth for message content; main writes what
 * arrives via IPC and reads on demand. Layout (mirrors `~/.claude/projects`):
 *
 *   ~/.devia-app/projects/
 *     -home-dherr-repos-myApp/
 *       session-<uuid>.json
 */
export interface SessionStore {
  newSessionId(): string;
  isValidSessionId(id: string | null | undefined): id is string;
  save(projectPath: string, session: PersistedSession): void;
  load(projectPath: string, sessionId: string): PersistedSession | null;
  list(projectPath: string): PersistedSession[];
  deleteOne(projectPath: string, sessionId: string): void;
  /** Drops the entire directory — used when a project is trashed. */
  deleteProjectSessions(projectPath: string): void;
  /**
   * Every session's stats rollup across ALL projects on disk (S-7), for the
   * Devia-wide cost aggregate. Stored rollups are returned as-is; sessions
   * without one are derived best-effort from their messages.
   */
  collectAllStats(): SessionStats[];
}
