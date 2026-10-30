import { describe, it, expect, vi } from 'vitest';
import { TelegramPoller } from './telegram-poller';
import { TelegramApiError, type TelegramClient, type TelegramUpdate } from './telegram-client';

function makeClient(impl: Partial<TelegramClient>): TelegramClient {
  return impl as TelegramClient;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** A promise that never resolves — used to park the poll loop after a batch. */
const never = <T>(): Promise<T> => new Promise<T>(() => { /* never resolves */ });
const noop = (): void => { /* intentionally empty */ };

describe('TelegramPoller', () => {
  it('advances the offset and dispatches updates in order', async () => {
    const updates: TelegramUpdate[][] = [
      [{ update_id: 10, message: { message_id: 1, date: 1, chat: { id: 5, type: 'private' }, text: 'a' } }],
    ];
    const offsets: number[] = [];
    const seen: number[] = [];
    const client = makeClient({
      getUpdates: vi.fn(async (offset: number) => {
        offsets.push(offset);
        const batch = updates.shift();
        if (batch) return batch;
        return never<TelegramUpdate[]>(); // park to stop further polling
      }),
    });
    const poller = new TelegramPoller({
      client,
      onUpdate: (u) => { seen.push(u.update_id); },
    });
    poller.start();
    await flush();
    await flush();
    expect(seen).toEqual([10]);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(11); // 10 + 1
    poller.stop();
    expect(poller.isRunning).toBe(false);
  });

  it('stops and reports on an auth error', async () => {
    const onAuthError = vi.fn();
    const client = makeClient({
      getUpdates: vi.fn(async () => { throw new TelegramApiError('Unauthorized', { statusCode: 401, authError: true }); }),
    });
    const poller = new TelegramPoller({ client, onUpdate: noop, onAuthError });
    poller.start();
    await flush();
    await flush();
    expect(onAuthError).toHaveBeenCalledOnce();
    expect(poller.isRunning).toBe(false);
  });

  it('backs off and retries on a transient error', async () => {
    const onError = vi.fn();
    let calls = 0;
    const sleep = vi.fn(async () => { /* no real wait */ });
    const client = makeClient({
      getUpdates: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('ECONNRESET');
        return never<TelegramUpdate[]>();
      }),
    });
    const poller = new TelegramPoller({ client, onUpdate: noop, onError, sleep, backoffMs: 1 });
    poller.start();
    await flush();
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1);
    poller.stop();
  });

  // A request that honours the abort signal — models a long-poll that stalls on
  // a dead socket (e.g. after the host slept) until the client gives up.
  const stallingClient = (onCall?: () => void): TelegramClient =>
    makeClient({
      getUpdates: vi.fn((_offset: number, _timeout: number, signal?: AbortSignal) => {
        onCall?.();
        return new Promise<TelegramUpdate[]>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }),
    });

  it('aborts a stalled long-poll on the client timeout and reconnects without an error', async () => {
    let calls = 0;
    const onError = vi.fn();
    const poller = new TelegramPoller({
      client: stallingClient(() => { calls += 1; }),
      onUpdate: noop,
      onError,
      requestTimeoutMs: 5,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 40)); // several 5 ms timeout cycles
    poller.stop();
    expect(calls).toBeGreaterThanOrEqual(2); // reconnected after each timeout
    expect(onError).not.toHaveBeenCalled();  // a timeout reconnect is not an error
  });

  it('wake() aborts the in-flight poll and reconnects immediately', async () => {
    let calls = 0;
    const onError = vi.fn();
    const poller = new TelegramPoller({
      client: stallingClient(() => { calls += 1; }),
      onUpdate: noop,
      onError,
      requestTimeoutMs: 100_000, // only wake() should trigger the reconnect
    });
    poller.start();
    await flush();
    expect(calls).toBe(1);
    poller.wake();
    await flush();
    await flush();
    expect(calls).toBe(2);                  // reconnected at once
    expect(onError).not.toHaveBeenCalled(); // wake reconnect is not an error
    poller.stop();
  });

  it('wake() is a no-op when the poller is not running', () => {
    const poller = new TelegramPoller({ client: makeClient({}), onUpdate: noop });
    expect(() => poller.wake()).not.toThrow();
  });
});
