import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker, type ResourceLimits } from 'node:worker_threads';
import type { IndexProgress } from '../../../../../shared/domain/code-graph';
import { readWriterLock, type WriterLockInfo } from '../db/writer-lock';
import type { IndexWorkerData, IndexWorkerInbound, IndexWorkerMessage } from './index-worker';
import { removeBuildingFiles, type IndexResult } from './orchestrator';

export interface RunIndexOptions {
  root: string;
  dataDir: string;
  onProgress: (p: IndexProgress) => void;
  workerEntry?: string;
  batchSize?: number;
  resourceLimits?: ResourceLimits;
}

export interface IndexRun {
  promise: Promise<IndexResult>;
  cancel(): void;
}

const CANCEL_GRACE_MS = 1000;

function errorFrom(msg: IndexWorkerMessage & { type: 'error' }): Error {
  const err = new Error(msg.message) as Error & { code?: string };
  err.name = msg.name;
  if (msg.code !== undefined) err.code = msg.code;
  return err;
}

function crashError(exitCode: number, cause: Error | undefined): Error {
  const detail = cause ? `: ${cause.message}` : '';
  const err = new Error(`Index worker crashed (exit code ${exitCode})${detail}`) as Error & {
    code: string;
    exitCode: number;
  };
  err.code = 'INDEX_WORKER_CRASHED';
  err.exitCode = exitCode;
  return err;
}

export function runIndexInWorker(opts: RunIndexOptions): IndexRun {
  const workerData: IndexWorkerData = { root: opts.root, dataDir: opts.dataDir };
  if (opts.batchSize !== undefined) workerData.batchSize = opts.batchSize;
  const spawnedAt = Date.now();
  const worker = new Worker(opts.workerEntry ?? path.join(__dirname, 'index-worker.js'), {
    workerData,
    ...(opts.resourceLimits ? { resourceLimits: opts.resourceLimits } : {}),
  });
  let outcome: IndexWorkerMessage | undefined;
  let ownLock: WriterLockInfo | undefined;
  let cancelled = false;
  let killTimer: NodeJS.Timeout | undefined;
  let crash: Error | undefined;

  // The worker shares this process's pid, so pid alone cannot tell its lock from another
  // in-process index. The first progress is emitted right after the lock is taken, which
  // lets us pin its exact `since`; before that, only a lock taken after spawning qualifies.
  const isOurLock = (lock: WriterLockInfo): boolean =>
    lock.owner === 'indexer' &&
    lock.pid === process.pid &&
    (ownLock ? lock.since === ownLock.since : lock.since >= spawnedAt);

  // A worker that dies without reporting (terminated, OOM, wasm abort, process.exit) never
  // reaches the orchestrator's finally, and its lock would look alive until it goes stale.
  const cleanupAfterDeath = (): void => {
    const lock = readWriterLock(opts.dataDir);
    if (lock && !isOurLock(lock)) return;
    removeBuildingFiles(opts.dataDir);
    if (lock) fs.rmSync(path.join(opts.dataDir, 'writer.lock'), { force: true });
  };

  const promise = new Promise<IndexResult>((resolve, reject) => {
    worker.on('message', (msg: IndexWorkerMessage) => {
      if (msg.type === 'progress') {
        if (!ownLock) {
          const lock = readWriterLock(opts.dataDir);
          if (lock && isOurLock(lock)) ownLock = lock;
        }
        if (!cancelled) opts.onProgress(msg.progress);
        return;
      }
      outcome = msg;
    });
    worker.on('error', (err) => {
      crash = err;
    });
    worker.on('exit', (exitCode) => {
      if (killTimer) clearTimeout(killTimer);
      if (!outcome) cleanupAfterDeath();
      if (outcome?.type === 'done') resolve(outcome.result);
      else if (cancelled) reject(new DOMException('Index cancelled', 'AbortError'));
      else if (outcome?.type === 'error') reject(errorFrom(outcome));
      else reject(crashError(exitCode, crash));
    });
  });

  return {
    promise,
    cancel(): void {
      if (cancelled || outcome) return;
      cancelled = true;
      const msg: IndexWorkerInbound = { type: 'cancel' };
      worker.postMessage(msg);
      killTimer = setTimeout(() => void worker.terminate(), CANCEL_GRACE_MS);
    },
  };
}
