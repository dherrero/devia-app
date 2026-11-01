import type {
  ProjectRegistry,
  QueueInspector,
  SessionStore,
  StateStore,
} from '../../../shared/ports';
import type { SessionStats } from '../../../../shared/domain/session-stats';
import type { RunMode } from '../../../../shared/domain/run-capabilities';
import { extractSessionIdentity } from '../../../../shared/domain/session';

/**
 * Switch the active session for a project: load its messages and update the
 * registry's `activeSessionId` so the next instruction continues that session
 * (Claude's `--resume <uuid>` resumes it).
 *
 * S-2 F0.2: the registry's native-conversation pointer (`agentSessionId` +
 * `agentSessionAgentId`) must follow the chosen session too — leaving the
 * previous session's pointer in place made the next prompt `--resume` the
 * WRONG conversation while the UI showed (and persisted into) the new one.
 */
export class SwitchSessionUseCase {
  constructor(private readonly deps: {
    registry: ProjectRegistry;
    sessions: SessionStore;
    state: StateStore;
    queue?: QueueInspector;
    /**
     * S-2 F2.3: notifies that a session owned by `ownerAgentId` was loaded
     * under `identity`, so a handoff summary can be precomputed in the
     * background. Best-effort — never blocks or fails the switch.
     */
    prepareHandoff?: (identity: string, sessionId: string, messages: unknown[], ownerAgentId: string | null) => void;
  }) {}

  execute(
    projectPath: string,
    sessionId: string,
  ): { id: string; messages: unknown[]; stats?: SessionStats; runMode?: RunMode } {
    // S-2 F0.4: hard guard. The renderer blocks busy switches too (F0.3), but
    // the UI can lose the race (a run starting between the click and the IPC)
    // and Telegram/queue paths never pass through the sidebar. A switch
    // mid-run would make the in-flight autosave persist the live conversation
    // into the newly chosen session. Stable codes, untranslated — i18n lives
    // in the renderer. `switchSession` is only invoked with the PRIMARY
    // pane's projectPath (additional panes use runKey identities and the F5
    // adopt flow), so isRunning(projectPath) is the right check.
    if (this.deps.registry.isRunning(projectPath)) {
      throw new Error('SESSION_BUSY');
    }
    // Parked queue items would be dispatched INTO the newly chosen session,
    // continuing the previous conversation inside it — refuse until drained.
    if ((this.deps.queue?.pendingCount(projectPath) ?? 0) > 0) {
      throw new Error('SESSION_QUEUE_PENDING');
    }
    if (!this.deps.sessions.isValidSessionId(sessionId)) {
      throw new Error('Session id no es un UUID válido');
    }
    const session = this.deps.sessions.load(projectPath, sessionId);
    if (!session) throw new Error('La sesión no existe');

    const record = this.deps.registry.getOrCreate(projectPath);
    record.activeSessionId = sessionId;
    record.newSession = false;
    // Restore the chosen session's native conversation. Sessions persisted
    // before F0.1 lack the stamped fields — derive them from the transcript.
    // When neither yields an identity the pointer goes null: the next run
    // starts a fresh native session (+ memory pre-injection, E-DSK-13).
    const identity = session.agentId !== undefined || session.agentSessionId !== undefined
      ? { agentId: session.agentId, agentSessionId: session.agentSessionId }
      : extractSessionIdentity(session.messages ?? []);
    record.agentSessionId = identity.agentSessionId ?? null;
    record.agentSessionAgentId = identity.agentId ?? null;
    this.deps.state.save();

    try {
      this.deps.prepareHandoff?.(projectPath, sessionId, session.messages ?? [], identity.agentId ?? null);
    } catch {
      /* enrichment is best-effort */
    }

    // The rollup rides along so the footer can restore this session's context
    // and cost (S-7) without re-scanning its messages.
    return {
      id: session.id,
      messages: session.messages ?? [],
      ...(session.stats && { stats: session.stats }),
      ...(session.runMode && { runMode: session.runMode }),
    };
  }
}
