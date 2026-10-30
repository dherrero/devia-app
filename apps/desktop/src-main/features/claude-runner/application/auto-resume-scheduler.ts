export type AutoResumeCancelReason = 'user' | 'stopped' | 'reset' | 'disabled' | 'replaced';

export interface AutoResumeSchedulerDeps {
  now(): number;
  /** Fires the resume. Throwing counts as handled: the job is already gone. */
  onDue(key: string): void;
  onScheduled(key: string, fireAt: number): void;
  onCancelled(key: string, reason: AutoResumeCancelReason): void;
  /** Wait added after the reported reset, so the window has really reopened. */
  marginMs?: number;
  /** Longest wait worth scheduling. Must cover the weekly window (7 days). */
  maxWaitMs?: number;
  /** Resumes in a row that ended in another limit hit before giving up. */
  maxConsecutive?: number;
  pollMs?: number;
}

const DEFAULT_MARGIN_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 8 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CONSECUTIVE = 3;
const DEFAULT_POLL_MS = 15_000;

/**
 * Resumes sessions cut short by the account's usage limit once it resets.
 *
 * Deadlines are checked by a poll against the wall clock rather than by one
 * long `setTimeout` per job: a timer does not advance while the machine sleeps,
 * so a laptop closed overnight would wake long past the reset and still wait.
 * `tick()` is also exposed so the shell can force a check on power resume.
 */
export class AutoResumeScheduler {
  private readonly jobs = new Map<string, number>();
  private readonly streak = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: AutoResumeSchedulerDeps) {}

  /** Returns whether a resume was scheduled (false: too far away, or the streak is spent). */
  schedule(key: string, resetsAt: number): boolean {
    const margin = this.deps.marginMs ?? DEFAULT_MARGIN_MS;
    const fireAt = resetsAt + margin;
    if (fireAt - this.deps.now() > (this.deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)) return false;
    if ((this.streak.get(key) ?? 0) >= (this.deps.maxConsecutive ?? DEFAULT_MAX_CONSECUTIVE)) return false;
    if (this.jobs.has(key)) this.cancel(key, 'replaced');
    this.jobs.set(key, fireAt);
    this.ensurePolling();
    this.deps.onScheduled(key, fireAt);
    return true;
  }

  isPending(key: string): boolean {
    return this.jobs.has(key);
  }

  cancel(key: string, reason: AutoResumeCancelReason): void {
    if (!this.jobs.delete(key)) return;
    if (reason !== 'replaced') this.streak.delete(key);
    this.stopPollingIfIdle();
    this.deps.onCancelled(key, reason);
  }

  /** A run finished without hitting the limit: the next limit starts a fresh streak. */
  noteCleanRun(key: string): void {
    this.streak.delete(key);
  }

  tick(): void {
    const now = this.deps.now();
    for (const [key, fireAt] of [...this.jobs]) {
      if (fireAt > now) continue;
      this.jobs.delete(key);
      this.streak.set(key, (this.streak.get(key) ?? 0) + 1);
      try {
        this.deps.onDue(key);
      } catch (err: unknown) {
        console.warn('[devia:auto-resume] resume failed:', err instanceof Error ? err.message : String(err));
      }
    }
    this.stopPollingIfIdle();
  }

  dispose(): void {
    this.jobs.clear();
    this.stopPollingIfIdle();
  }

  private ensurePolling(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.deps.pollMs ?? DEFAULT_POLL_MS);
    this.timer.unref?.();
  }

  private stopPollingIfIdle(): void {
    if (this.jobs.size > 0 || this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
