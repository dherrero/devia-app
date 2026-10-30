import type {
  ProjectRegistry,
  SessionStore,
  StateStore,
} from '../../../shared/ports';

export interface DeleteSessionResult {
  wasActive: boolean;
}

/**
 * Delete a single persisted session file. If the deleted session was the
 * project's active one, clear `activeSessionId` so the next instruction
 * starts a fresh session instead of trying to resume the missing uuid.
 *
 * S-3: an explicit, user-confirmed delete also tears down the session's git
 * worktree AND branch when the persisted session carries them (additional
 * split-pane sessions) — unlike pane close, which preserves the branch for
 * the F2.2 recovery chain.
 */
export class DeleteSessionUseCase {
  constructor(private readonly deps: {
    registry: ProjectRegistry;
    sessions: SessionStore;
    state: StateStore;
    /** S-3: full worktree + branch teardown (git feature export), best-effort. */
    cleanupWorktree?: (baseProject: string, sessionId: string, branch?: string) => unknown;
  }) {}

  execute(projectPath: string, sessionId: string): DeleteSessionResult {
    if (!this.deps.sessions.isValidSessionId(sessionId)) {
      throw new Error('Session id no es un UUID válido');
    }

    const record = this.deps.registry.find(projectPath);
    const wasActive = record?.activeSessionId === sessionId;

    // S-2 F0.4: deleting the ACTIVE session while its agent runs would pull
    // the file out from under the in-flight autosave. Deleting a NON-active
    // session while another runs stays allowed. Stable code; renderer maps it.
    if (wasActive && this.deps.registry.isRunning(projectPath)) {
      throw new Error('SESSION_BUSY');
    }
    // S-3: a session mounted in a split pane keys the registry by its own id
    // (runKey === sessionId) — deleting it mid-run would rip the worktree out
    // from under the agent. The sidebar blocks this too; this is the
    // authoritative guard (Telegram/queue races).
    if (this.deps.registry.isRunning(sessionId)) {
      throw new Error('SESSION_BUSY');
    }

    // Read the worktree hints BEFORE the file is gone.
    const session = this.deps.sessions.load(projectPath, sessionId);

    this.deps.sessions.deleteOne(projectPath, sessionId);

    if (wasActive && record) {
      record.activeSessionId = null;
      record.newSession = true;
      this.deps.state.save();
    }

    if (session?.worktreeBranch !== undefined) {
      try {
        this.deps.cleanupWorktree?.(projectPath, sessionId, session.worktreeBranch);
      } catch {
        // best-effort — the history delete already succeeded
      }
    }

    return { wasActive };
  }
}
