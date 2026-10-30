/**
 * Tracks projects whose agent compacted its own context mid-session and
 * therefore owe a one-shot memory re-injection on their next run (E-DSK-13
 * Fase D).
 *
 * Why this exists: Devia drives headless CLI agents. When an agent compacts
 * (summarises away older turns to fit its context window) it loses what it
 * knew. Devia cannot inject into an already-running process, so the recovery
 * is deferred: the compaction is recorded here, and the runner re-injects
 * Devia's memory context on the *next* run. Fase A only injects on the first
 * turn of a session, so without this flag a resumed-but-compacted session
 * would never get its memory back.
 *
 * State is intentionally in-memory only: a compaction that is never followed
 * by another run in the same app lifetime needs no recovery, and a fresh
 * session re-injects via Fase A anyway.
 */
export class MemoryReinjectionTracker {
  private readonly pending = new Set<string>();

  /** Record that the agent compacted its context for this project. */
  markCompacted(projectPath: string): void {
    this.pending.add(projectPath);
  }

  /** Non-destructive check: is a re-injection owed for this project? */
  isPending(projectPath: string): boolean {
    return this.pending.has(projectPath);
  }

  /**
   * Consume the pending flag, returning whether one was owed. Call this once
   * per run at the point the runner decides whether to re-inject, so a single
   * compaction triggers exactly one re-injection.
   */
  consume(projectPath: string): boolean {
    return this.pending.delete(projectPath);
  }

  /** Drop any pending flag without consuming its result (e.g. on session reset). */
  clear(projectPath: string): void {
    this.pending.delete(projectPath);
  }
}
