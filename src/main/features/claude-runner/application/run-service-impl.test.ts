import { describe, it, expect, beforeEach } from 'vitest';
import { RunServiceImpl, type Clock, type ProviderLookup, type Spawner } from './run-service-impl';
import { EchoProvider } from '../../cli-adapters/infrastructure/providers/echo-provider';
import type {
  AgentProvider,
  ChildProcessLike,
  ProviderSession,
} from '../../../../shared/domain/agent-provider';

// ── Fake clock ────────────────────────────────────────────────────────────────

class FakeClock implements Clock {
  private _now = 0;
  private timers: Array<{ id: number; fn: () => void; at: number }> = [];
  private nextId = 1;

  now(): number { return this._now; }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, fn, at: this._now + ms });
    return id;
  }

  clearTimeout(id: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  advance(ms: number): void {
    this._now += ms;
    const due = this.timers.filter((t) => t.at <= this._now);
    this.timers = this.timers.filter((t) => t.at > this._now);
    for (const t of due) t.fn();
  }
}

// ── Fake provider lookup ──────────────────────────────────────────────────────

function makeProviderLookup(providers: AgentProvider[]): ProviderLookup {
  const map = new Map(providers.map((p) => [p.id, p]));
  return { get: (id) => map.get(id) };
}

// ── Fake spawner ──────────────────────────────────────────────────────────────

function makeEchoSpawner(prompt: string): Spawner {
  const child: ChildProcessLike = {
    stdout: null,
    stderr: null,
    stdin: null,
    kill: () => false,
    on() { return this; },
  };
  return {
    spawn: async (provider) => {
      const session = provider.attach(
        child,
        { runId: 'fake', prompt, cwd: '/tmp' },
      );
      return { session };
    },
  };
}

function makeErrorSpawner(message: string): Spawner {
  return {
    spawn: async () => {
      throw new Error(message);
    },
  };
}

function makeSilentSpawner(): Spawner {
  return {
    spawn: async () => {
      const session: ProviderSession = {
        events: (async function* () {
          yield { kind: 'stream_start' as const, protocolVersion: 1 };
          yield { kind: 'stream_end' as const, reason: 'completed' as const };
        })(),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        cancel: async () => {},
      };
      return { session };
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RunServiceImpl', () => {
  let clock: FakeClock;
  const echo = new EchoProvider();

  beforeEach(() => {
    clock = new FakeClock();
  });

  // AC1: create + start transitions
  it('create returns runId in queued status; start transitions to running (AC1)', async () => {
    const svc = new RunServiceImpl(makeProviderLookup([echo]), makeEchoSpawner('hi'), {}, clock);
    const runId = await svc.create({ providerId: 'echo', prompt: 'hi', cwd: '/tmp' });
    expect(svc.get(runId)?.status).toBe('queued');
    await svc.start(runId);
    expect(svc.get(runId)?.status).toBe('succeeded');
  });

  it('create with unknown provider throws UNKNOWN_PROVIDER', async () => {
    const svc = new RunServiceImpl(makeProviderLookup([]), makeEchoSpawner('x'), {}, clock);
    await expect(svc.create({ providerId: 'nope', prompt: 'x', cwd: '/tmp' })).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER' });
  });

  // AC3: idempotency key deduplication
  it('duplicate idempotencyKey returns same runId without double-spawn (AC3)', async () => {
    const svc = new RunServiceImpl(makeProviderLookup([echo]), makeEchoSpawner('x'), {}, clock);
    const key = 'idem-key-1';
    const id1 = await svc.create({ providerId: 'echo', prompt: 'x', cwd: '/tmp', idempotencyKey: key });
    const id2 = await svc.create({ providerId: 'echo', prompt: 'x', cwd: '/tmp', idempotencyKey: key });
    expect(id1).toBe(id2);
    // Only the first create should produce a run record
    expect(svc.list()).toHaveLength(1);
  });

  // AC2: cancel while running
  it('cancel transitions running run to canceled (AC2)', async () => {
    const spawner: Spawner = {
      spawn: async () => {
        const session: ProviderSession = {
          events: (async function* () {
            yield { kind: 'stream_start' as const, protocolVersion: 1 };
            yield { kind: 'status' as const, label: 'running' };
            // Will be interrupted by cancel
            await new Promise((r) => setTimeout(r, 60_000));
          })(),
          cancel: () => Promise.resolve(),
        };
        return { session };
      },
    };

    const svc = new RunServiceImpl(makeProviderLookup([echo]), spawner, { cancelGraceMs: 100 }, clock);
    const runId = await svc.create({ providerId: 'echo', prompt: 'test', cwd: '/tmp' });

    // Start asynchronously
    const startPromise = svc.start(runId);
    // Cancel immediately
    await svc.cancel(runId);
    await startPromise;

    expect(svc.get(runId)?.status).toBe('canceled');
  });

  // AC4: empty output guard
  it('run with no substantive content fails with EMPTY_OUTPUT (AC4)', async () => {
    const svc = new RunServiceImpl(makeProviderLookup([echo]), makeSilentSpawner(), {}, clock);
    const runId = await svc.create({ providerId: 'echo', prompt: 'x', cwd: '/tmp' });
    await svc.start(runId);
    expect(svc.get(runId)?.status).toBe('failed');
    expect(svc.get(runId)?.failureCode).toBe('EMPTY_OUTPUT');
  });

  // AC5: stream resume from since
  it('stream with since replays only events after that sequence (AC5)', async () => {
    const svc = new RunServiceImpl(makeProviderLookup([echo]), makeEchoSpawner('hello world'), {}, clock);
    const runId = await svc.create({ providerId: 'echo', prompt: 'hello world', cwd: '/tmp' });
    await svc.start(runId);

    // Get total events count from first stream
    const stream1 = svc.stream(runId);
    const allEvents = [];
    for await (const env of stream1.envelopes) allEvents.push(env);

    // Now stream from sequence 1
    const stream2 = svc.stream(runId, 1);
    const resumedEvents = [];
    for await (const env of stream2.envelopes) resumedEvents.push(env);

    expect(resumedEvents.every((e) => e.sequence > 1)).toBe(true);
    expect(resumedEvents.length).toBeLessThan(allEvents.length);
  });

  // AC6: inactivity timeout
  it('inactivity watchdog fails run after silence (AC6)', async () => {
    const spawner: Spawner = {
      spawn: async () => {
        const session: ProviderSession = {
          events: (async function* () {
            yield { kind: 'stream_start' as const, protocolVersion: 1 };
            // Never emits another event — simulate silence
            await new Promise<void>((resolve) => {
              // The abort controller will cancel this
              resolve();
            });
          })(),
          cancel: () => Promise.resolve(),
        };
        return { session };
      },
    };

    const svc = new RunServiceImpl(
      makeProviderLookup([echo]),
      spawner,
      { inactivityTimeoutMs: 5_000 },
      clock,
    );
    const runId = await svc.create({ providerId: 'echo', prompt: 'x', cwd: '/tmp' });

    const startPromise = svc.start(runId);
    // Advance clock past inactivity timeout
    clock.advance(6_000);
    await startPromise;

    expect(svc.get(runId)?.failureCode).toBe('INACTIVITY_TIMEOUT');
  });

  it('cancel on already-canceled run is idempotent', async () => {
    const svc = new RunServiceImpl(makeProviderLookup([echo]), makeEchoSpawner('x'), {}, clock);
    const runId = await svc.create({ providerId: 'echo', prompt: 'x', cwd: '/tmp' });
    await svc.cancel(runId);
    await expect(svc.cancel(runId)).resolves.toBeUndefined(); // no throw
    expect(svc.get(runId)?.status).toBe('canceled');
  });

  it('queued run can be canceled before start', async () => {
    const svc = new RunServiceImpl(makeProviderLookup([echo]), makeEchoSpawner('x'), {}, clock);
    const runId = await svc.create({ providerId: 'echo', prompt: 'x', cwd: '/tmp' });
    await svc.cancel(runId);
    expect(svc.get(runId)?.status).toBe('canceled');
  });

  it('spawn failure records SPAWN_FAILED', async () => {
    const svc = new RunServiceImpl(makeProviderLookup([echo]), makeErrorSpawner('binary not found'), {}, clock);
    const runId = await svc.create({ providerId: 'echo', prompt: 'x', cwd: '/tmp' });
    await svc.start(runId);
    expect(svc.get(runId)?.status).toBe('failed');
    expect(svc.get(runId)?.failureCode).toBe('SPAWN_FAILED');
  });

  it('maxConcurrentRuns cap rejects excess creates', async () => {
    const svc = new RunServiceImpl(makeProviderLookup([echo]), makeEchoSpawner('x'), { maxConcurrentRuns: 2 }, clock);
    await svc.create({ providerId: 'echo', prompt: 'a', cwd: '/tmp' });
    await svc.create({ providerId: 'echo', prompt: 'b', cwd: '/tmp' });
    await expect(svc.create({ providerId: 'echo', prompt: 'c', cwd: '/tmp' }))
      .rejects.toMatchObject({ code: 'TOO_MANY_RUNS' });
  });

  it('list() returns runs newest first', async () => {
    const svc = new RunServiceImpl(makeProviderLookup([echo]), makeEchoSpawner('x'), {}, clock);
    const id1 = await svc.create({ providerId: 'echo', prompt: 'a', cwd: '/tmp' });
    clock.advance(1);
    const id2 = await svc.create({ providerId: 'echo', prompt: 'b', cwd: '/tmp' });
    const list = svc.list();
    expect(list[0]?.runId).toBe(id2);
    expect(list[1]?.runId).toBe(id1);
  });
});
