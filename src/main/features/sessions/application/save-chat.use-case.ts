import type {
  ProjectRegistry,
  SessionStore,
  StateStore,
} from '../../../shared/ports';
import type { SessionStats, StatsSourceMessage } from '../../../../shared/domain/session-stats';
import { buildSessionStats } from '../../../../shared/domain/session-stats';
import type { PersistedSession } from '../../../../shared/domain/session';
import type { RunMode } from '../../../../shared/domain/run-capabilities';
import { extractSessionIdentity } from '../../../../shared/domain/session';

/**
 * Snapshot save. The renderer debounces calls to ~500ms, so this isn't hot.
 * Generates a session id on demand the first time we see a project that
 * doesn't have one yet (i.e. the post-reset / first-instruction case).
 */
export class SaveChatUseCase {
  constructor(private readonly deps: {
    registry: ProjectRegistry;
    sessions: SessionStore;
    state: StateStore;
  }) {}

  execute(projectPath: string, messages: unknown[], stats?: SessionStats, runMode?: RunMode): true {
    const record = this.deps.registry.getOrCreate(projectPath);

    if (!record.activeSessionId) {
      record.activeSessionId = this.deps.sessions.newSessionId();
      // Persist the link so a crash before the next IPC still restores
      // correctly.
      this.deps.state.save();
    }

    const existing = this.deps.sessions.load(projectPath, record.activeSessionId);
    // The renderer owns the rollup. When a save omits it (legacy callers,
    // saves that predate the stats wiring) keep the previously stored one, or
    // — if none was ever stored — backfill a best-effort one derived from the
    // messages (T-85) so the session still aggregates and restores later.
    const resolvedStats = stats
      ?? existing?.stats
      ?? (messages.length > 0
        ? buildSessionStats({
            messages: messages as StatsSourceMessage[],
            fallbackAgentId: 'unknown',
            now: Date.now(),
          })
        : undefined);
    this.deps.sessions.save(projectPath, {
      id: record.activeSessionId,
      project: projectPath,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      messages,
      ...(resolvedStats && { stats: resolvedStats }),
      ...resolveIdentity(messages, existing),
      // S-3 F2.1: the primary never stamps a workdir (it runs on the base
      // checkout by definition) but a previously persisted one must survive.
      ...(existing?.workdir !== undefined && { workdir: existing.workdir }),
      ...(existing?.worktreeBranch !== undefined && { worktreeBranch: existing.worktreeBranch }),
      ...resolveRunMode(runMode, existing),
    });
    return true;
  }

  /**
   * Split-view save (S-13 T-156). An ADDITIONAL split pane runs its live state
   * under a synthetic per-session key (its runKey) but its history must live
   * under the REAL base project with its OWN session id — so `listSessions(base)`
   * surfaces it (T-157) and it survives a restart. Unlike `execute`, this never
   * touches the registry's `activeSessionId`: the base project's active session
   * belongs to the primary pane and must not be hijacked by an additional one.
   */
  saveAs(
    baseProject: string,
    sessionId: string,
    messages: unknown[],
    stats?: SessionStats,
    workdir?: string,
    worktreeBranch?: string,
    runMode?: RunMode,
  ): true {
    if (!this.deps.sessions.isValidSessionId(sessionId)) return true;

    const existing = this.deps.sessions.load(baseProject, sessionId);
    const resolvedStats = stats
      ?? existing?.stats
      ?? (messages.length > 0
        ? buildSessionStats({
            messages: messages as StatsSourceMessage[],
            fallbackAgentId: 'unknown',
            now: Date.now(),
          })
        : undefined);
    // S-3 F2.1: where the session runs. Like identity, never erase a
    // previously persisted value when this save omits it.
    const resolvedWorkdir = workdir ?? existing?.workdir;
    const resolvedBranch = worktreeBranch ?? existing?.worktreeBranch;
    this.deps.sessions.save(baseProject, {
      id: sessionId,
      project: baseProject,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      messages,
      ...(resolvedStats && { stats: resolvedStats }),
      ...resolveIdentity(messages, existing),
      ...(resolvedWorkdir !== undefined && { workdir: resolvedWorkdir }),
      ...(resolvedBranch !== undefined && { worktreeBranch: resolvedBranch }),
      ...resolveRunMode(runMode, existing),
    });
    return true;
  }
}

/**
 * Identity stamping (S-2 F0.1): derive from the transcript, but never erase a
 * previously persisted identity when the new messages carry none (e.g. a save
 * fired before the session's first run completed).
 */
function resolveIdentity(
  messages: unknown[],
  existing: PersistedSession | null,
): Pick<PersistedSession, 'agentId' | 'agentSessionId'> {
  const extracted = extractSessionIdentity(messages);
  const agentId = extracted.agentId ?? existing?.agentId;
  const agentSessionId = extracted.agentSessionId ?? existing?.agentSessionId;
  return {
    ...(agentId !== undefined && { agentId }),
    ...(agentSessionId !== undefined && { agentSessionId }),
  };
}

/** Like identity: a save that omits the mode never erases a persisted one. */
function resolveRunMode(
  runMode: RunMode | undefined,
  existing: PersistedSession | null,
): Pick<PersistedSession, 'runMode'> {
  const resolved = runMode ?? existing?.runMode;
  return resolved !== undefined ? { runMode: resolved } : {};
}
