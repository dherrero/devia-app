import * as crypto from 'node:crypto';
import type { AgentProvider, ProviderSession } from '../../../../shared/domain/agent-provider';
import type {
  CreateRunRequest,
  RunEventEnvelope,
  RunRecord,
  RunServiceOptions,
  RunStream,
} from '../../../../shared/domain/run-service';
import { DEFAULT_RUN_SERVICE_OPTIONS } from '../../../../shared/domain/run-service';
import type { AgentRunStatus } from '../../../../shared/domain/chat-session';
import type { NormalizedEvent } from '../../../../shared/domain/normalized-event';
import type { RunService } from '../domain/run-service-port';

// ── Minimal clock interface for testing ───────────────────────────────────────

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

// ── Provider registry port ────────────────────────────────────────────────────

export interface ProviderLookup {
  get(id: string): AgentProvider | undefined;
}

// ── Spawn port (allows test doubles) ─────────────────────────────────────────

export interface SpawnResult {
  session: ProviderSession;
}

export interface Spawner {
  spawn(provider: AgentProvider, req: CreateRunRequest): Promise<SpawnResult>;
}

// ── Internal run state ────────────────────────────────────────────────────────

interface RunState {
  record: RunRecord;
  events: RunEventEnvelope[];
  nextSequence: number;
  subscribers: Set<(env: RunEventEnvelope) => void>;
  abortController?: AbortController;
  watchdogId?: unknown;
}

// ── RunService implementation ─────────────────────────────────────────────────

/**
 * State machine that owns the full lifecycle of a chat run:
 * create → start → stream → terminal.
 *
 * Dependencies are injected so the implementation is testable without
 * real CLI binaries.
 */
export class RunServiceImpl implements RunService {
  private readonly runs = new Map<string, RunState>();
  /** Maps idempotencyKey → runId for deduplication. */
  private readonly idempotencyKeys = new Map<string, { runId: string; createdAt: number }>();
  private readonly options: RunServiceOptions;
  private readonly clock: Clock;

  constructor(
    private readonly providers: ProviderLookup,
    private readonly spawner: Spawner,
    options: Partial<RunServiceOptions> = {},
    clock: Clock = realClock,
  ) {
    this.options = { ...DEFAULT_RUN_SERVICE_OPTIONS, ...options };
    this.clock = clock;
  }

  // ── create ──────────────────────────────────────────────────────────────────

  async create(req: CreateRunRequest): Promise<string> {
    // Idempotency check
    if (req.idempotencyKey) {
      this.sweepIdempotencyKeys();
      const existing = this.idempotencyKeys.get(req.idempotencyKey);
      if (existing) return existing.runId;
    }

    // Validate provider
    const provider = this.providers.get(req.providerId);
    if (!provider) {
      throw Object.assign(new Error(`Unknown provider: ${req.providerId}`), {
        code: 'UNKNOWN_PROVIDER',
      });
    }

    // Enforce concurrency cap
    const running = [...this.runs.values()].filter(
      (s) => s.record.status === 'running' || s.record.status === 'queued',
    );
    if (running.length >= this.options.maxConcurrentRuns) {
      throw Object.assign(new Error('Max concurrent runs reached'), {
        code: 'TOO_MANY_RUNS',
      });
    }

    const runId = crypto.randomUUID();
    const now = this.clock.now();
    const record: RunRecord = {
      runId,
      providerId: req.providerId,
      status: 'queued',
      createdAt: now,
      ...(req.projectId !== undefined ? { projectId: req.projectId } : {}),
      ...(req.conversationId !== undefined ? { conversationId: req.conversationId } : {}),
      ...(req.idempotencyKey !== undefined ? { idempotencyKey: req.idempotencyKey } : {}),
    };

    this.runs.set(runId, {
      record,
      events: [],
      nextSequence: 0,
      subscribers: new Set(),
    });

    if (req.idempotencyKey) {
      this.idempotencyKeys.set(req.idempotencyKey, { runId, createdAt: now });
    }

    return runId;
  }

  // ── start ───────────────────────────────────────────────────────────────────

  async start(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`Run not found: ${runId}`);

    if (state.record.status !== 'queued') return; // idempotent for already-started

    const provider = this.providers.get(state.record.providerId);
    if (!provider) {
      this.failRun(state, 'UNKNOWN_PROVIDER', `Unknown provider: ${state.record.providerId}`);
      return;
    }

    // Transition → running
    this.updateStatus(state, 'running', { startedAt: this.clock.now() });

    const abortController = new AbortController();
    state.abortController = abortController;

    // Start inactivity watchdog
    this.resetWatchdog(state);

    try {
      // Find the original request details — we stored enough in record for now
      const req: CreateRunRequest = {
        providerId: state.record.providerId,
        prompt: '', // Real impl would store the prompt in RunRecord or retrieve from store
        cwd: process.cwd(),
        ...(state.record.projectId !== undefined ? { projectId: state.record.projectId } : {}),
        ...(state.record.conversationId !== undefined ? { conversationId: state.record.conversationId } : {}),
      };

      const { session } = await this.spawner.spawn(provider, req);

      let hasSubstantiveContent = false;

      // Use Promise.race so the AbortController (watchdog / cancel) can
      // interrupt a blocked async iterator without waiting for the next yield.
      const abortPromise = new Promise<void>((resolve) => {
        if (abortController.signal.aborted) { resolve(); return; }
        abortController.signal.addEventListener('abort', () => resolve(), { once: true });
      });

      const eventIter = session.events[Symbol.asyncIterator]();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const race = await Promise.race([
          eventIter.next().then((r) => ({ kind: 'event' as const, r })),
          abortPromise.then(() => ({ kind: 'abort' as const, r: undefined })),
        ]);

        if (race.kind === 'abort') break;
        const { r } = race;
        if (r.done) break;

        const event = r.value;
        // Reset inactivity watchdog on each event
        this.resetWatchdog(state);

        if (event.kind === 'text_delta' || event.kind === 'tool_call') {
          hasSubstantiveContent = true;
        }

        this.appendEvent(state, event);
        if (event.kind === 'stream_end') break;
      }

      const statusAfterStream = state.record.status as AgentRunStatus;
      if (!isTerminal(statusAfterStream)) {
        // Empty-output guard (only when run ended normally, not via watchdog/cancel)
        const caps = provider.capabilities({ available: true, authStatus: 'ok' });
        if (caps.streaming && !hasSubstantiveContent) {
          this.failRun(state, 'EMPTY_OUTPUT', 'Provider produced no substantive output');
        } else {
          this.updateStatus(state, 'succeeded', { endedAt: this.clock.now() });
        }
      }
    } catch (err) {
      const statusOnError = state.record.status as AgentRunStatus;
      if (!isTerminal(statusOnError)) {
        const message = err instanceof Error ? err.message : String(err);
        this.failRun(state, 'SPAWN_FAILED', message);
      }
    } finally {
      this.clearWatchdog(state);
    }
  }

  // ── cancel ──────────────────────────────────────────────────────────────────

  async cancel(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) return;
    if (state.record.status === 'canceled') return; // idempotent
    if (isTerminal(state.record.status)) return;

    this.clearWatchdog(state);
    state.abortController?.abort();
    this.updateStatus(state, 'canceled', { endedAt: this.clock.now() });
  }

  // ── get / list ───────────────────────────────────────────────────────────────

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId)?.record;
  }

  list(): RunRecord[] {
    return [...this.runs.values()]
      .map((s) => s.record)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // ── stream ───────────────────────────────────────────────────────────────────

  stream(runId: string, since?: number): RunStream {
    const state = this.runs.get(runId);
    let cancelled = false;

    const envelopes: AsyncIterable<RunEventEnvelope> = (async function* () {
      if (!state) return;

      // Replay persisted events
      const replayed = since !== undefined
        ? state.events.filter((e) => e.sequence > since)
        : [...state.events];
      for (const env of replayed) {
        if (cancelled) return;
        yield env;
      }

      // If already terminal, nothing more to stream
      if (isTerminal(state.record.status)) return;

      // Subscribe to live events
      let resolve: ((env: RunEventEnvelope | null) => void) | undefined;
      const queue: RunEventEnvelope[] = [];

      const push = (env: RunEventEnvelope) => {
        if (resolve) {
          const r = resolve;
          resolve = undefined;
          r(env);
        } else {
          queue.push(env);
        }
      };

      state.subscribers.add(push);

      try {
        while (!cancelled) {
          if (queue.length > 0) {
            const env = queue.shift();
            if (env) yield env;
          } else {
            const next = await new Promise<RunEventEnvelope | null>((r) => {
              resolve = r;
              // Wake up when the run becomes terminal (no more events)
              if (isTerminal(state.record.status) && queue.length === 0) {
                r(null);
              }
            });
            if (next === null || cancelled) break;
            yield next;
          }

          if (isTerminal(state.record.status) && queue.length === 0) break;
        }
      } finally {
        state.subscribers.delete(push);
      }
    })();

    return {
      envelopes,
      cancel: () => { cancelled = true; },
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private appendEvent(state: RunState, payload: NormalizedEvent): void {
    const env: RunEventEnvelope = {
      runId: state.record.runId,
      sequence: state.nextSequence++,
      emittedAt: this.clock.now(),
      payload,
    };
    state.events.push(env);
    for (const sub of state.subscribers) sub(env);
  }

  private updateStatus(
    state: RunState,
    status: AgentRunStatus,
    fields: Partial<RunRecord> = {},
  ): void {
    state.record = { ...state.record, status, ...fields };
    // Wake up any blocking stream awaits when terminal
    if (isTerminal(status)) {
      for (const sub of state.subscribers) sub({ runId: state.record.runId, sequence: -1, emittedAt: this.clock.now(), payload: { kind: 'stream_end', reason: status === 'canceled' ? 'aborted' : 'completed' } });
    }
  }

  private failRun(state: RunState, code: string, message: string): void {
    this.updateStatus(state, 'failed', {
      endedAt: this.clock.now(),
      failureCode: code,
      failureMessage: message,
    });
    this.appendEvent(state, { kind: 'error', code, message, recoverable: false });
  }

  private resetWatchdog(state: RunState): void {
    this.clearWatchdog(state);
    state.watchdogId = this.clock.setTimeout(() => {
      if (state.record.status === 'running') {
        state.abortController?.abort();
        this.failRun(state, 'INACTIVITY_TIMEOUT', 'No output received within inactivity window');
      }
    }, this.options.inactivityTimeoutMs);
  }

  private clearWatchdog(state: RunState): void {
    if (state.watchdogId !== undefined) {
      this.clock.clearTimeout(state.watchdogId);
      state.watchdogId = undefined;
    }
  }

  private sweepIdempotencyKeys(): void {
    const cutoff = this.clock.now() - this.options.idempotencyRetentionMs;
    for (const [key, val] of this.idempotencyKeys) {
      if (val.createdAt < cutoff) this.idempotencyKeys.delete(key);
    }
  }
}

function isTerminal(status: AgentRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}
