import type {
  ProjectRegistry,
  QueueInspector,
  SessionStore,
  StateStore,
} from '../../../shared/ports';
import type { SessionStats } from '../../../../shared/domain/session-stats';
import { extractSessionIdentity } from '../../../../shared/domain/session';

/** How the adopted session ended up running (S-3 F2.2). */
export type AdoptIsolation = 'worktree' | 'recreated' | 'none';

export interface AdoptSessionResult {
  id: string;
  messages: unknown[];
  stats?: SessionStats;
  /** Effective cwd the pane must run in. */
  workdir: string;
  /** Session worktree branch, when isolated. */
  branch?: string;
  isolation: AdoptIsolation;
}

/**
 * Load an existing persisted session under an ADDITIONAL split pane's
 * identity (S-2 F5.1). `switchSession` always mutates the PRIMARY pane's
 * record (identity = projectPath); adopting into a pane must mutate the
 * record keyed by the pane's runKey without touching the primary's.
 *
 * S-3 F2.2 recovery chain (supersedes the S-2 v1 "always base checkout"):
 *   1. the persisted `workdir` is still a live managed worktree → reattach
 *      (native resume works — it was the session's cwd; files intact);
 *   2. worktree swept but `worktreeBranch` survived → recreate the worktree
 *      from that branch (commits recovered; native resume may miss — the
 *      runner's session-not-found fallback already handles that);
 *   3. neither → base checkout, flagged `isolation: 'none'` so the renderer
 *      shows the no-isolation chip and asks consent before the first run.
 */
export class AdoptSessionUseCase {
  constructor(private readonly deps: {
    registry: ProjectRegistry;
    sessions: SessionStore;
    state: StateStore;
    queue?: QueueInspector;
    /** S-2 F2.3: background handoff-summary precompute (see SwitchSessionUseCase). */
    prepareHandoff?: (identity: string, sessionId: string, messages: unknown[], ownerAgentId: string | null) => void;
    /** S-3 F2.2: worktree validation + recreation (git feature exports). */
    worktrees?: {
      isLive: (workdir: string) => boolean;
      recreate: (baseProject: string, sessionId: string, branch: string) => string | null;
    };
  }) {}

  execute(
    baseProject: string,
    runKey: string,
    sessionId: string,
  ): AdoptSessionResult {
    if (!this.deps.sessions.isValidSessionId(sessionId)) {
      throw new Error('Session id no es un UUID válido');
    }
    // Same hard guards / codes as switchSession (F0.4), keyed by the PANE's
    // identity: a busy pane (or one with parked queue items) must not have its
    // record re-pointed mid-flight.
    if (this.deps.registry.isRunning(runKey)) {
      throw new Error('SESSION_BUSY');
    }
    if ((this.deps.queue?.pendingCount(runKey) ?? 0) > 0) {
      throw new Error('SESSION_QUEUE_PENDING');
    }

    // Additional panes persist their history under the BASE project (T-156),
    // so the load is uniform regardless of where the session was created.
    const session = this.deps.sessions.load(baseProject, sessionId);
    if (!session) throw new Error('La sesión no existe');

    const record = this.deps.registry.getOrCreate(runKey);
    record.activeSessionId = sessionId;
    record.newSession = false;
    const identity = session.agentId !== undefined || session.agentSessionId !== undefined
      ? { agentId: session.agentId, agentSessionId: session.agentSessionId }
      : extractSessionIdentity(session.messages ?? []);
    record.agentSessionId = identity.agentSessionId ?? null;
    record.agentSessionAgentId = identity.agentId ?? null;
    this.deps.state.save();

    try {
      this.deps.prepareHandoff?.(runKey, sessionId, session.messages ?? [], identity.agentId ?? null);
    } catch {
      /* enrichment is best-effort */
    }

    // S-3 F2.2: recovery chain — live worktree → recreate from branch → base.
    let workdir = baseProject;
    let branch: string | undefined;
    let isolation: AdoptIsolation = 'none';
    try {
      if (session.workdir !== undefined && this.deps.worktrees?.isLive(session.workdir)) {
        workdir = session.workdir;
        branch = session.worktreeBranch;
        isolation = 'worktree';
      } else if (session.worktreeBranch !== undefined) {
        const recreated = this.deps.worktrees?.recreate(baseProject, sessionId, session.worktreeBranch) ?? null;
        if (recreated !== null) {
          workdir = recreated;
          branch = session.worktreeBranch;
          isolation = 'recreated';
        }
      }
    } catch {
      /* recovery is best-effort — the base checkout always works */
    }

    return {
      id: session.id,
      messages: session.messages ?? [],
      ...(session.stats && { stats: session.stats }),
      workdir,
      ...(branch !== undefined && { branch }),
      isolation,
    };
  }
}
