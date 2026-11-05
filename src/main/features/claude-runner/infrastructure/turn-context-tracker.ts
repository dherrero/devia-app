/** Sessions remembered at once; beyond it the oldest is forgotten (and its block resent once). */
const MAX_SESSIONS = 256;

/**
 * Which per-turn context block (S-40) each native agent session has already
 * been given, so an unchanged block is not repeated in every turn's history.
 *
 * In memory on purpose: after an app restart the block is simply sent once more,
 * which is harmless; persisting it would add state that can go stale.
 */
export class TurnContextTracker {
  private readonly delivered = new Map<string, string>();

  /** True when the block must travel in this turn. */
  shouldSend(input: { resumeSessionId: string | undefined; hash: string; force?: boolean }): boolean {
    if (input.resumeSessionId === undefined || input.force === true) return true;
    return this.delivered.get(input.resumeSessionId) !== input.hash;
  }

  /** The model consumed a turn carrying `hash` inside native session `sessionId`. */
  markDelivered(sessionId: string, hash: string): void {
    this.delivered.delete(sessionId);
    this.delivered.set(sessionId, hash);
    if (this.delivered.size > MAX_SESSIONS) {
      const oldest = this.delivered.keys().next().value;
      if (oldest !== undefined) this.delivered.delete(oldest);
    }
  }

  /** Forget a session (context compacted, resume failed): the next turn resends. */
  invalidate(sessionId: string): void {
    this.delivered.delete(sessionId);
  }
}
