import type {
  CreateRunRequest,
  RunRecord,
  RunStream,
} from '../../../../shared/domain/run-service';

/**
 * Port interface for the `RunService` state machine.
 *
 * Concrete implementations wire `ProviderRegistry` (TS-Agent-01),
 * `ChatSessionStore` (TS-Agent-05), and normalization (TS-Agent-04).
 */
export interface RunService {
  /**
   * Validate the request and create a run record in `queued` status.
   * Returns the new `runId`, or the existing `runId` when an
   * `idempotencyKey` matches an in-flight or recent run.
   */
  create(req: CreateRunRequest): Promise<string>;

  /**
   * Transition a `queued` run to `running` and spawn the agent.
   * No-op (returns immediately) when called on an already-running run
   * (idempotent per AC1).
   */
  start(runId: string): Promise<void>;

  /**
   * Request cancellation. Idempotent — safe to call multiple times.
   * A queued run transitions directly to `canceled` without spawning.
   */
  cancel(runId: string): Promise<void>;

  /**
   * Get the current record for a run. Returns `undefined` when not found.
   */
  get(runId: string): RunRecord | undefined;

  /**
   * List all known run records (most recent first).
   */
  list(): RunRecord[];

  /**
   * Open an event stream for a run, optionally resuming from `since`
   * (exclusive). Events are replayed from the store then forwarded live.
   */
  stream(runId: string, since?: number): RunStream;
}
