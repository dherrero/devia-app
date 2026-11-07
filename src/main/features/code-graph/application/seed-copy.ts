import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { SeedCopyData, SeedCopyMessage } from './seed-copy-worker';

/** Runs the snapshot copy in a short-lived worker so a large graph never freezes the main thread. */
export function runSeedCopy(data: SeedCopyData, workerEntry?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let outcome: SeedCopyMessage | undefined;
    let crash: Error | undefined;
    const worker = new Worker(workerEntry ?? path.join(__dirname, 'seed-copy-worker.js'), { workerData: data });
    worker.on('message', (msg: SeedCopyMessage) => {
      outcome = msg;
    });
    worker.on('error', (err) => {
      crash = err;
    });
    worker.on('exit', (code) => {
      if (outcome?.type === 'done') resolve();
      else if (outcome?.type === 'error') reject(new Error(outcome.message));
      else reject(crash ?? new Error(`Seed worker exited with code ${code}`));
    });
  });
}
