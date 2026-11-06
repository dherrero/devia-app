import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { IndexProgress } from '../../../../../shared/domain/code-graph';
import { readWriterLock } from '../db/writer-lock';
import type { IndexWorkerData, IndexWorkerInbound, IndexWorkerMessage } from './index-worker';
import { removeBuildingFiles, type IndexResult } from './orchestrator';

export interface RunIndexOptions {
  root: string;
  dataDir: string;
  onProgress: (p: IndexProgress) => void;
  workerEntry?: string;
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

// A terminated worker never reaches the orchestrator's finally: its lock carries this
// process's pid (threads share it), so it would look alive and block every later index.
function cleanupAfterKill(dataDir: string): void {
  removeBuildingFiles(dataDir);
  const lock = readWriterLock(dataDir);
  if (lock && lock.owner === 'indexer' && lock.pid === process.pid)
    fs.rmSync(path.join(dataDir, 'writer.lock'), { force: true });
}

export function runIndexInWorker(opts: RunIndexOptions): IndexRun {
  const workerData: IndexWorkerData = { root: opts.root, dataDir: opts.dataDir };
  const worker = new Worker(opts.workerEntry ?? path.join(__dirname, 'index-worker.js'), { workerData });
  let outcome: IndexWorkerMessage | undefined;
  let cancelled = false;
  let killed = false;
  let killTimer: NodeJS.Timeout | undefined;
  let crash: Error | undefined;

  const promise = new Promise<IndexResult>((resolve, reject) => {
    worker.on('message', (msg: IndexWorkerMessage) => {
      if (msg.type === 'progress') {
        if (!cancelled) opts.onProgress(msg.progress);
        return;
      }
      outcome = msg;
    });
    worker.on('error', (err) => {
      crash = err;
    });
    worker.on('exit', () => {
      if (killTimer) clearTimeout(killTimer);
      if (killed) cleanupAfterKill(opts.dataDir);
      if (outcome?.type === 'done') resolve(outcome.result);
      else if (cancelled) reject(new DOMException('Index cancelled', 'AbortError'));
      else if (outcome?.type === 'error') reject(errorFrom(outcome));
      else reject(crash ?? new Error('Index worker exited unexpectedly'));
    });
  });

  return {
    promise,
    cancel(): void {
      if (cancelled || outcome) return;
      cancelled = true;
      const msg: IndexWorkerInbound = { type: 'cancel' };
      worker.postMessage(msg);
      killTimer = setTimeout(() => {
        killed = true;
        void worker.terminate();
      }, CANCEL_GRACE_MS);
    },
  };
}
