import type { PersistedSession } from '../../shared/domain/session';
import type { SessionStore } from './ports';

/**
 * The agent chosen for a single session (S-53), kept out of the way of the big
 * session files: reads are cached, and a choice made before the session exists
 * on disk (a fresh split pane) waits in memory until the session's first save.
 */
export class SessionAgentIndex {
  private readonly cache = new Map<string, string | null>();
  private readonly pending = new Map<string, string>();

  constructor(private readonly deps: { sessions: Pick<SessionStore, 'load' | 'save'> }) {}

  private key(projectPath: string, sessionId: string): string {
    return `${projectPath}\u0000${sessionId}`;
  }

  get(projectPath: string, sessionId: string): string | null {
    const key = this.key(projectPath, sessionId);
    const pending = this.pending.get(key);
    if (pending !== undefined) return pending;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const stored = this.deps.sessions.load(projectPath, sessionId)?.preferredAgentId ?? null;
    this.cache.set(key, stored);
    return stored;
  }

  /** `null` removes the choice. A session that is not on disk yet keeps it in memory. */
  set(projectPath: string, sessionId: string, agentId: string | null): void {
    const key = this.key(projectPath, sessionId);
    const session = this.deps.sessions.load(projectPath, sessionId);
    if (!session) {
      if (agentId === null) this.pending.delete(key);
      else this.pending.set(key, agentId);
      this.cache.delete(key);
      return;
    }
    const next: PersistedSession = { ...session };
    if (agentId === null) delete next.preferredAgentId;
    else next.preferredAgentId = agentId;
    this.deps.sessions.save(projectPath, next);
    this.pending.delete(key);
    this.cache.set(key, agentId);
  }

  /**
   * What a session save must write for `preferredAgentId`: a choice made before
   * the session existed (consumed once), otherwise what is already stored.
   */
  resolveForSave(projectPath: string, sessionId: string, existing: string | undefined): string | undefined {
    const key = this.key(projectPath, sessionId);
    const pending = this.pending.get(key);
    if (pending !== undefined) {
      this.pending.delete(key);
      this.cache.set(key, pending);
      return pending;
    }
    return existing;
  }
}
