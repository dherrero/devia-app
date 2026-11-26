import {
  isWorkerRunKey,
  workerRunKey,
  type WorkerRole,
  type WorkerStatus,
} from '../../../../shared/domain/cross-agent';

export { isWorkerRunKey, workerRunKey };

export type WorkerState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'timeout';

export interface WorkerRun {
  id: string;
  parentKey: string;
  turnId: string;
  taskId: string;
  role: WorkerRole;
  agentId: string;
  /** The run identity the worker's events are routed by (see {@link workerRunKey}). */
  runKey: string;
  state: WorkerState;
  status?: WorkerStatus;
  startedAt?: number;
  endedAt?: number;
}

export interface WorkerSpec {
  taskId: string;
  role: WorkerRole;
  agentId: string;
  /** The controller's turn (its run id): the per-turn cap counts per parent + turn. */
  turnId: string;
}

export interface WorkerSlot {
  run: WorkerRun;
  /** Frees the slot and records the end. Idempotent; a worker already cancelled stays `cancelled`. */
  release(state: Exclude<WorkerState, 'queued' | 'running'>, status?: WorkerStatus): void;
}

export class WorkerLimitError extends Error {
  constructor(readonly code: 'per_turn_limit' | 'cancelled', message: string) {
    super(message);
    this.name = 'WorkerLimitError';
  }
}

export const DISPATCH_CIRCUIT_BREAK_FAILURES = 3;

export interface WorkerRegistryOptions {
  /** Workers running at once across the WHOLE app, not per parent. */
  maxConcurrent: number;
  maxPerTurn: number;
  onChange(run: WorkerRun): void;
}

export interface WorkerRegistry {
  acquire(parentKey: string, spec: WorkerSpec): Promise<WorkerSlot>;
  /** Depth 1: a worker may not launch workers. */
  rejectIfWorker(runKey: string): boolean;
  registerCancel(workerId: string, cancel: () => void): void;
  cancel(workerId: string): boolean;
  /** Cancels every queued or running worker of `parentKey`; returns how many. */
  cancelParent(parentKey: string): number;
  list(parentKey: string): WorkerRun[];
  recordFailure(taskId: string): 'retry' | 'circuit_broken';
  recordSuccess(taskId: string): void;
}

interface Entry {
  run: WorkerRun;
  cancel?: () => void;
  released: boolean;
  grant?: (slot: WorkerSlot) => void;
  deny?: (error: WorkerLimitError) => void;
}

export function createWorkerRegistry(options: WorkerRegistryOptions): WorkerRegistry {
  const entries = new Map<string, Entry>();
  const queue: Entry[] = [];
  const turnCounts = new Map<string, number>();
  const failures = new Map<string, number>();
  let running = 0;
  let sequence = 0;

  const emit = (run: WorkerRun): void => {
    try {
      options.onChange({ ...run });
    } catch {
      /* an observer must never break the registry */
    }
  };

  const slotFor = (entry: Entry): WorkerSlot => ({
    run: entry.run,
    release(state, status) {
      if (entry.released) return;
      entry.released = true;
      running = Math.max(0, running - 1);
      if (entry.run.state === 'running') {
        entry.run.state = state;
        if (status !== undefined) entry.run.status = status;
      }
      entry.run.endedAt = Date.now();
      emit(entry.run);
      pump();
    },
  });

  const pump = (): void => {
    while (running < options.maxConcurrent && queue.length > 0) {
      const entry = queue.shift() as Entry;
      running += 1;
      entry.run.state = 'running';
      entry.run.startedAt = Date.now();
      emit(entry.run);
      entry.grant?.(slotFor(entry));
    }
  };

  const cancelEntry = (entry: Entry): boolean => {
    const { run } = entry;
    if (run.state === 'queued') {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      run.state = 'cancelled';
      run.endedAt = Date.now();
      emit(run);
      entry.deny?.(new WorkerLimitError('cancelled', `Worker ${run.id} was cancelled before it started.`));
      return true;
    }
    if (run.state === 'running') {
      run.state = 'cancelled';
      emit(run);
      try {
        entry.cancel?.();
      } catch {
        /* the kill is best-effort; release() still frees the slot */
      }
      return true;
    }
    return false;
  };

  return {
    acquire(parentKey, spec) {
      const turnKey = `${parentKey}|${spec.turnId}`;
      const used = turnCounts.get(turnKey) ?? 0;
      if (used >= options.maxPerTurn) {
        return Promise.reject(
          new WorkerLimitError('per_turn_limit', `At most ${options.maxPerTurn} workers per turn; this one was not started.`),
        );
      }
      turnCounts.set(turnKey, used + 1);
      sequence += 1;
      const run: WorkerRun = {
        id: `W-${sequence}`,
        parentKey,
        turnId: spec.turnId,
        taskId: spec.taskId,
        role: spec.role,
        agentId: spec.agentId,
        runKey: workerRunKey(parentKey, spec.taskId, sequence),
        state: 'queued',
      };
      return new Promise<WorkerSlot>((resolve, reject) => {
        const entry: Entry = { run, released: false, grant: resolve, deny: reject };
        entries.set(run.id, entry);
        queue.push(entry);
        emit(run);
        pump();
      });
    },
    rejectIfWorker: isWorkerRunKey,
    registerCancel(workerId, cancel) {
      const entry = entries.get(workerId);
      if (entry) entry.cancel = cancel;
    },
    cancel(workerId) {
      const entry = entries.get(workerId);
      return entry ? cancelEntry(entry) : false;
    },
    cancelParent(parentKey) {
      let count = 0;
      for (const entry of [...entries.values()]) {
        if (entry.run.parentKey === parentKey && cancelEntry(entry)) count += 1;
      }
      return count;
    },
    list(parentKey) {
      return [...entries.values()].filter((e) => e.run.parentKey === parentKey).map((e) => ({ ...e.run }));
    },
    recordFailure(taskId) {
      const next = (failures.get(taskId) ?? 0) + 1;
      failures.set(taskId, next);
      return next >= DISPATCH_CIRCUIT_BREAK_FAILURES ? 'circuit_broken' : 'retry';
    },
    recordSuccess(taskId) {
      failures.delete(taskId);
    },
  };
}
