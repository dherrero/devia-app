import { describe, it, expect, vi, afterEach } from 'vitest';
import { RunGateway } from './run-gateway';
import { createRunCompletion } from './run-completion';
import type { RunId } from '../../shared/domain/agent';

const RUN_A = 'run-a' as RunId;
const RUN_B = 'run-b' as RunId;
const delta = (text: string): string => JSON.stringify({ type: 'text_delta', delta: text });

function trackedGateway(): { gateway: RunGateway; unsubscribed: () => number; subscribed: () => number } {
  const gateway = new RunGateway();
  const original = gateway.subscribe.bind(gateway);
  let subs = 0;
  let unsubs = 0;
  gateway.subscribe = (listener) => {
    subs += 1;
    const off = original(listener);
    return () => {
      unsubs += 1;
      off();
    };
  };
  return { gateway, unsubscribed: () => unsubs, subscribed: () => subs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createRunCompletion', () => {
  it('resolves done with the concatenated assistant text only', async () => {
    const { gateway } = trackedGateway();
    const pending = createRunCompletion(gateway).await('w1');
    gateway.publish({ type: 'start', project: 'w1', runId: RUN_A, agentId: 'pi' });
    gateway.publish({ type: 'output', project: 'w1', runId: RUN_A, line: delta('Hel') });
    gateway.publish({ type: 'output', project: 'w1', runId: RUN_A, line: JSON.stringify({ type: 'tool_use', name: 'Read' }) });
    gateway.publish({ type: 'output', project: 'w1', runId: RUN_A, line: delta('lo') });
    gateway.publish({ type: 'end', project: 'w1', runId: RUN_A, code: 0 });
    await expect(pending).resolves.toEqual({ status: 'done', finalText: 'Hello' });
  });

  it('resolves failed and carries the error when the run exits with an error', async () => {
    const { gateway } = trackedGateway();
    const pending = createRunCompletion(gateway).await('w1');
    gateway.publish({ type: 'start', project: 'w1', runId: RUN_A });
    gateway.publish({ type: 'output', project: 'w1', runId: RUN_A, line: delta('partial') });
    gateway.publish({ type: 'end', project: 'w1', runId: RUN_A, code: 1, error: 'boom' });
    await expect(pending).resolves.toEqual({ status: 'failed', finalText: 'partial', error: 'boom' });
  });

  it('resolves cancelled when the run ended with a cancel reason', async () => {
    const { gateway } = trackedGateway();
    const pending = createRunCompletion(gateway).await('w1');
    gateway.publish({ type: 'start', project: 'w1', runId: RUN_A });
    gateway.publish({ type: 'end', project: 'w1', runId: RUN_A, code: null, cancelReason: 'user' });
    const outcome = await pending;
    expect(outcome.status).toBe('cancelled');
  });

  it('resolves failed when the run ends without ever starting (busy / early exit)', async () => {
    const { gateway } = trackedGateway();
    const pending = createRunCompletion(gateway).await('w1');
    gateway.publish({ type: 'end', project: 'w1', runId: RUN_A, code: 1, error: 'busy' });
    await expect(pending).resolves.toEqual({ status: 'failed', finalText: '', error: 'busy' });
  });

  it('times out, calls onTimeout and resolves timeout with the text so far', async () => {
    vi.useFakeTimers();
    const { gateway } = trackedGateway();
    const onTimeout = vi.fn();
    const pending = createRunCompletion(gateway).await('w1', { timeoutMs: 1000, onTimeout });
    gateway.publish({ type: 'start', project: 'w1', runId: RUN_A });
    gateway.publish({ type: 'output', project: 'w1', runId: RUN_A, line: delta('so far') });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ status: 'timeout', finalText: 'so far' });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('ignores events of another run on the same key and of another key', async () => {
    const { gateway } = trackedGateway();
    const pending = createRunCompletion(gateway).await('w1');
    gateway.publish({ type: 'start', project: 'w1', runId: RUN_A });
    gateway.publish({ type: 'output', project: 'w1', runId: RUN_B, line: delta('FOREIGN') });
    gateway.publish({ type: 'end', project: 'w1', runId: RUN_B, code: 1, error: 'other run' });
    gateway.publish({ type: 'output', project: 'w2', runId: RUN_A, line: delta('OTHER KEY') });
    gateway.publish({ type: 'output', project: 'w1', runId: RUN_A, line: delta('mine') });
    gateway.publish({ type: 'end', project: 'w1', runId: RUN_A, code: 0 });
    await expect(pending).resolves.toEqual({ status: 'done', finalText: 'mine' });
  });

  it('releases its listener on done, failed, cancelled and timeout', async () => {
    vi.useFakeTimers();
    const { gateway, unsubscribed, subscribed } = trackedGateway();
    const completion = createRunCompletion(gateway);

    const done = completion.await('d');
    gateway.publish({ type: 'start', project: 'd', runId: RUN_A });
    gateway.publish({ type: 'end', project: 'd', runId: RUN_A, code: 0 });
    await done;

    const failed = completion.await('f');
    gateway.publish({ type: 'start', project: 'f', runId: RUN_A });
    gateway.publish({ type: 'end', project: 'f', runId: RUN_A, code: 1, error: 'x' });
    await failed;

    const cancelled = completion.await('c');
    gateway.publish({ type: 'start', project: 'c', runId: RUN_A });
    gateway.publish({ type: 'end', project: 'c', runId: RUN_A, code: null, cancelReason: 'idle' });
    await cancelled;

    const timedOut = completion.await('t', { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await timedOut;

    expect(subscribed()).toBe(4);
    expect(unsubscribed()).toBe(4);
  });
});
