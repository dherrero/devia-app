import { parentPort, workerData } from 'node:worker_threads';
import type { IndexProgress } from '../../../../../shared/domain/code-graph';
import { indexProject, type IndexResult } from './orchestrator';

export interface IndexWorkerData {
  root: string;
  dataDir: string;
}

export type IndexWorkerInbound = { type: 'cancel' };

export type IndexWorkerMessage =
  | { type: 'progress'; progress: IndexProgress }
  | { type: 'done'; result: IndexResult }
  | { type: 'error'; name: string; message: string; code?: string };

const PROGRESS_INTERVAL_MS = 100;

function startWorker(): void {
  const port = parentPort;
  if (!port) return;
  const { root, dataDir } = workerData as IndexWorkerData;
  const controller = new AbortController();
  port.on('message', (msg: IndexWorkerInbound) => {
    if (msg.type === 'cancel') controller.abort();
  });

  let lastSent = 0;
  let lastPhase: IndexProgress['phase'] | undefined;
  const post = (msg: IndexWorkerMessage): void => port.postMessage(msg);

  indexProject({
    root,
    dataDir,
    signal: controller.signal,
    onProgress: (progress) => {
      const now = Date.now();
      if (progress.phase === lastPhase && now - lastSent < PROGRESS_INTERVAL_MS) return;
      lastPhase = progress.phase;
      lastSent = now;
      post({ type: 'progress', progress });
    },
  })
    .then((result) => post({ type: 'done', result }))
    .catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      const code = (e as { code?: unknown }).code;
      post(
        typeof code === 'string'
          ? { type: 'error', name: e.name, message: e.message, code }
          : { type: 'error', name: e.name, message: e.message },
      );
    })
    .finally(() => port.close());
}

startWorker();
