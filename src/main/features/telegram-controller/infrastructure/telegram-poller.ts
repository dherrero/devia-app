/**
 * Long-polling loop over `getUpdates` (E-DSK-14).
 *
 * Kept separate from the client (HTTP) and the controller (policy) so the loop
 * — with its abort/backoff semantics — can be unit-tested in isolation. The
 * loop owns the `offset` cursor and an AbortController so `stop()` cancels the
 * in-flight long-poll immediately instead of waiting out the 30 s timeout.
 *
 * Wake resilience (fix/telegram-status-branch): each long-poll also gets a
 * client-side timeout, and `wake()` aborts the in-flight request on demand.
 * Both reconnect immediately without surfacing an error or backing off. This
 * matters on a desktop OS that sleeps: when the host wakes, the socket opened
 * before sleeping is dead but the server reply never comes, so plain `fetch`
 * would hang on undici's 300 s `bodyTimeout` before failing. The timeout caps
 * that to a few seconds; `wake()` (driven by the OS resume event) makes it
 * instant.
 */
import type { TelegramClient, TelegramUpdate } from './telegram-client';
import { TelegramApiError } from './telegram-client';

export interface TelegramPollerDeps {
  client: TelegramClient;
  onUpdate: (update: TelegramUpdate) => void | Promise<void>;
  /** Surfaced on every poll failure so the controller can update its status. */
  onError?: (err: unknown) => void;
  /** Called once when a 401 stops the loop, so the controller flips to auth-error. */
  onAuthError?: () => void;
  /** Long-poll window in seconds (default 30). */
  longPollSec?: number;
  /** Backoff after a transient error, in ms (default 3000). */
  backoffMs?: number;
  /**
   * Client-side cap on a single long-poll, in ms. A dead socket (e.g. after the
   * host slept) is aborted and reconnected instead of hanging on undici's 300 s
   * `bodyTimeout`. Default `longPollSec * 1000 + 5000` (server window + margin).
   * Set to 0 to disable.
   */
  requestTimeoutMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class TelegramPoller {
  private running = false;
  private offset = 0;
  private abort: AbortController | null = null;
  private requestTimer: ReturnType<typeof setTimeout> | null = null;
  // True when WE aborted the in-flight poll to reconnect (client timeout or a
  // wake() after sleep) — distinguishes it from stop() and from a real network
  // error so the loop reconnects at once, without an error status or backoff.
  private reconnect = false;
  private readonly longPollSec: number;
  private readonly backoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: TelegramPollerDeps) {
    this.longPollSec = deps.longPollSec ?? 30;
    this.backoffMs = deps.backoffMs ?? 3000;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? this.longPollSec * 1000 + 5000;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.reconnect = false;
    this.clearTimer();
    this.abort?.abort();
    this.abort = null;
  }

  /**
   * Abort the in-flight long-poll and reconnect immediately. Call on wake from
   * OS sleep (powerMonitor 'resume'): the socket opened before sleeping is dead,
   * so without this the next reply waits out `requestTimeoutMs`. No-op when the
   * loop isn't running.
   */
  wake(): void {
    if (!this.running || !this.abort) return;
    this.reconnect = true;
    this.abort.abort();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const ctrl = new AbortController();
      this.abort = ctrl;
      this.reconnect = false;
      this.armTimeout(ctrl);
      try {
        const updates = await this.deps.client.getUpdates(
          this.offset,
          this.longPollSec,
          ctrl.signal,
        );
        this.clearTimer();
        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (!this.running) break;
          await this.deps.onUpdate(update);
        }
      } catch (err) {
        this.clearTimer();
        // A deliberate stop() aborts the request; swallow and exit quietly.
        if (!this.running) break;
        // Our own timeout/wake abort: the socket was (likely) dead — reconnect
        // now, no error surfaced, no backoff.
        if (this.reconnect) continue;
        if (err instanceof TelegramApiError && err.authError) {
          this.running = false;
          this.deps.onAuthError?.();
          break;
        }
        this.deps.onError?.(err);
        await this.sleep(this.backoffMs);
      }
    }
  }

  private armTimeout(ctrl: AbortController): void {
    if (this.requestTimeoutMs <= 0) return;
    this.requestTimer = setTimeout(() => {
      this.reconnect = true;
      ctrl.abort();
    }, this.requestTimeoutMs);
    this.requestTimer.unref?.();
  }

  private clearTimer(): void {
    if (this.requestTimer) {
      clearTimeout(this.requestTimer);
      this.requestTimer = null;
    }
  }
}
