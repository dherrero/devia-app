import { describe, it, expect, vi } from 'vitest';
import {
  WorkerLimitError,
  createWorkerRegistry,
  isWorkerRunKey,
  workerRunKey,
  type WorkerRun,
  type WorkerSlot,
} from './worker-registry';

const spec = (taskId: string, turnId = 'turn-1') => ({
  taskId,
  role: 'implementer' as const,
  agentId: 'pi',
  turnId,
});

function build(over: Partial<{ maxConcurrent: number; maxPerTurn: number }> = {}) {
  const changes: WorkerRun[] = [];
  const registry = createWorkerRegistry({
    maxConcurrent: over.maxConcurrent ?? 3,
    maxPerTurn: over.maxPerTurn ?? 8,
    onChange: (run) => changes.push({ ...run }),
  });
  return { registry, changes };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const states = (registry: ReturnType<typeof build>['registry'], parent: string): string[] =>
  registry.list(parent).map((r) => r.state);

describe('worker run keys', () => {
  it('marks worker keys and only worker keys', () => {
    const key = workerRunKey('proj', 'T-1', 1);
    expect(isWorkerRunKey(key)).toBe(true);
    expect(isWorkerRunKey('proj')).toBe(false);
    expect(isWorkerRunKey('a-session-id')).toBe(false);
  });

  it('never collides between parents, tasks or attempts', () => {
    const keys = new Set([
      workerRunKey('a', 'T-1', 1),
      workerRunKey('b', 'T-1', 1),
      workerRunKey('a', 'T-2', 1),
      workerRunKey('a', 'T-1', 2),
    ]);
    expect(keys.size).toBe(4);
  });

  it('rejects delegation from a worker (depth 1)', () => {
    const { registry } = build();
    expect(registry.rejectIfWorker(workerRunKey('proj', 'T-1', 1))).toBe(true);
    expect(registry.rejectIfWorker('proj')).toBe(false);
  });
});

describe('semaphore', () => {
  it('runs at most maxConcurrent at once and starts the queued ones in order', async () => {
    const { registry } = build({ maxConcurrent: 3, maxPerTurn: 20 });
    const slots = Array.from({ length: 10 }, (_, i) => registry.acquire('p', spec(`T-${i}`)));
    await flush();
    expect(states(registry, 'p').filter((s) => s === 'running')).toHaveLength(3);
    expect(states(registry, 'p').filter((s) => s === 'queued')).toHaveLength(7);

    const first = (await slots[0]) as WorkerSlot;
    first.release('done');
    await flush();
    const running = registry.list('p').filter((r) => r.state === 'running').map((r) => r.taskId);
    expect(running).toEqual(['T-1', 'T-2', 'T-3']);
  });

  it('is global across parents, not per parent', async () => {
    const { registry } = build({ maxConcurrent: 3 });
    for (let i = 0; i < 2; i++) void registry.acquire('p1', spec(`A-${i}`));
    for (let i = 0; i < 2; i++) void registry.acquire('p2', spec(`B-${i}`));
    await flush();
    const running = [...registry.list('p1'), ...registry.list('p2')].filter((r) => r.state === 'running');
    expect(running).toHaveLength(3);
  });

  it('release is idempotent: a double release frees one slot only', async () => {
    const { registry } = build({ maxConcurrent: 1, maxPerTurn: 20 });
    const a = await registry.acquire('p', spec('T-1'));
    void registry.acquire('p', spec('T-2'));
    void registry.acquire('p', spec('T-3'));
    a.release('done');
    a.release('done');
    await flush();
    expect(registry.list('p').filter((r) => r.state === 'running').map((r) => r.taskId)).toEqual(['T-2']);
  });

  it('reports queued → running → done through onChange', async () => {
    const { registry, changes } = build({ maxConcurrent: 1, maxPerTurn: 20 });
    const a = await registry.acquire('p', spec('T-1'));
    a.release('done', 'DONE');
    const seen = changes.filter((c) => c.taskId === 'T-1').map((c) => c.state);
    expect(seen).toEqual(['queued', 'running', 'done']);
    expect(registry.list('p')[0]).toMatchObject({ state: 'done', status: 'DONE' });
  });
});

describe('per-turn cap', () => {
  it('rejects the call beyond maxPerTurn with a reason, and a new turn starts clean', async () => {
    const { registry } = build({ maxConcurrent: 20, maxPerTurn: 2 });
    await registry.acquire('p', spec('T-1', 'turn-1'));
    await registry.acquire('p', spec('T-2', 'turn-1'));
    await expect(registry.acquire('p', spec('T-3', 'turn-1'))).rejects.toBeInstanceOf(WorkerLimitError);
    await expect(registry.acquire('p', spec('T-3', 'turn-1'))).rejects.toMatchObject({ code: 'per_turn_limit' });
    await expect(registry.acquire('p', spec('T-3', 'turn-2'))).resolves.toBeDefined();
  });
});

describe('cancellation', () => {
  it('cancelParent calls every cancel of that parent only and returns the count', async () => {
    const { registry } = build();
    const a = await registry.acquire('p', spec('T-1'));
    const b = await registry.acquire('p', spec('T-2'));
    const other = await registry.acquire('q', spec('T-9'));
    const cancelA = vi.fn();
    const cancelB = vi.fn();
    const cancelOther = vi.fn();
    registry.registerCancel(a.run.id, cancelA);
    registry.registerCancel(b.run.id, cancelB);
    registry.registerCancel(other.run.id, cancelOther);

    expect(registry.cancelParent('p')).toBe(2);
    expect(cancelA).toHaveBeenCalledTimes(1);
    expect(cancelB).toHaveBeenCalledTimes(1);
    expect(cancelOther).not.toHaveBeenCalled();
    expect(states(registry, 'p')).toEqual(['cancelled', 'cancelled']);
  });

  it('keeps the slot until the caller releases, then starts the next queued worker', async () => {
    const { registry } = build({ maxConcurrent: 1, maxPerTurn: 20 });
    const a = await registry.acquire('p', spec('T-1'));
    registry.registerCancel(a.run.id, vi.fn());
    registry.cancelParent('p');
    // The cancelled process may still be dying: its slot is not free until release().
    const next = registry.acquire('p', spec('T-2', 'turn-2'));
    await flush();
    expect(registry.list('p').find((r) => r.taskId === 'T-2')?.state).toBe('queued');
    a.release('cancelled');
    await flush();
    expect(registry.list('p').find((r) => r.taskId === 'T-2')?.state).toBe('running');
    await next;
  });

  it('cancelling a queued worker rejects its acquire and leaves no queued or running entry', async () => {
    const { registry } = build({ maxConcurrent: 1, maxPerTurn: 20 });
    const a = await registry.acquire('p', spec('T-1'));
    const queued = registry.acquire('p', spec('T-2'));
    const assertion = expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    registry.cancelParent('p');
    await assertion;
    expect(states(registry, 'p').filter((s) => s === 'queued')).toHaveLength(0);
    a.release('cancelled');
    expect(states(registry, 'p').filter((s) => s === 'queued' || s === 'running')).toHaveLength(0);
    // the slot is free again
    await expect(registry.acquire('p', spec('T-3', 'turn-2'))).resolves.toBeDefined();
  });

  it('a settled worker is not cancelled again', async () => {
    const { registry } = build();
    const a = await registry.acquire('p', spec('T-1'));
    const cancel = vi.fn();
    registry.registerCancel(a.run.id, cancel);
    a.release('done');
    expect(registry.cancelParent('p')).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('circuit breaker', () => {
  it('breaks after three consecutive failures of the same task', () => {
    const { registry } = build();
    expect(registry.recordFailure('T-1')).toBe('retry');
    expect(registry.recordFailure('T-1')).toBe('retry');
    expect(registry.recordFailure('T-1')).toBe('circuit_broken');
  });

  it('a success in between resets the count; tasks are independent', () => {
    const { registry } = build();
    registry.recordFailure('T-1');
    registry.recordFailure('T-1');
    registry.recordSuccess('T-1');
    expect(registry.recordFailure('T-1')).toBe('retry');
    expect(registry.recordFailure('T-2')).toBe('retry');
  });
});

describe('run key reuse (fix rounds)', () => {
  it('lets a follow-up round of the same task reuse the first run key', async () => {
    const { registry } = build();
    const first = await registry.acquire('p', spec('T-1'));
    first.release('done');
    const again = await registry.acquire('p', { ...spec('T-1', 'turn-2'), runKey: first.run.runKey });
    expect(again.run.runKey).toBe(first.run.runKey);
    expect(again.run.id).not.toBe(first.run.id);
  });
});
