import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IndexProgress } from '../../../../../shared/domain/code-graph';
import { acquireWriterLock, readWriterLock } from '../db/writer-lock';
import { runIndexInWorker } from './index-runner';
import { perfBudget } from '../graph/test-graph';

const workerEntry = path.join(__dirname, '__fixtures__', 'ts-worker-shim.cjs');

let root: string;
let dataDir: string;

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-runner-root-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-runner-data-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('runIndexInWorker', () => {
  it('indexes in a worker thread and forwards progress', async () => {
    write('src/a.ts', "import { b } from './b';\nexport const a = () => b();\n");
    write('src/b.ts', 'export function b(): number { return 1; }\n');
    const progress: IndexProgress[] = [];
    const run = runIndexInWorker({ root, dataDir, onProgress: (p) => progress.push(p), workerEntry });
    const result = await run.promise;

    expect(result.files).toBe(2);
    expect(result.languages).toEqual({ typescript: 2 });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.map((p) => p.phase)).toContain('finalize');
    expect(fs.readdirSync(dataDir).sort()).toEqual(['graph.db']);
  }, 15_000);

  it('cancel() during parse stops the worker quickly and keeps the previous graph.db', async () => {
    const total = 400;
    for (let i = 0; i < total; i++)
      write(`src/m${i}.ts`, `export function f${i}(x: number): number {\n  return x + ${i};\n}\n`);
    fs.writeFileSync(path.join(dataDir, 'graph.db'), 'previous');

    let cancelledAt = 0;
    let cancelledProgress: IndexProgress | undefined;
    const run = runIndexInWorker({
      root,
      dataDir,
      workerEntry,
      batchSize: 1,
      onProgress: (p) => {
        if (cancelledAt === 0 && p.phase === 'parse' && p.filesDone >= 2) {
          cancelledAt = Date.now();
          cancelledProgress = p;
          run.cancel();
        }
      },
    });

    await expect(run.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelledProgress?.filesDone).toBeLessThan(total);
    expect(Date.now() - cancelledAt).toBeLessThan(perfBudget(2000));
    expect(fs.readdirSync(dataDir).sort()).toEqual(['graph.db']);
    expect(fs.readFileSync(path.join(dataDir, 'graph.db'), 'utf8')).toBe('previous');
    expect(readWriterLock(dataDir)).toBeNull();

    const again = runIndexInWorker({ root, dataDir, workerEntry, onProgress: () => undefined });
    expect((await again.promise).files).toBe(total);
  }, 15_000);

  it.each([
    ['process.exit', 'crash-exit-shim.cjs', {}],
    ['an uncaught async throw', 'crash-throw-shim.cjs', {}],
    ['running out of memory', 'crash-oom-shim.cjs', { resourceLimits: { maxOldGenerationSizeMb: 16 } }],
  ])('a worker that dies by %s rejects and frees the lock and building files', async (_how, shim, extra) => {
    fs.writeFileSync(path.join(dataDir, 'graph.db'), 'previous');
    const run = runIndexInWorker({
      root,
      dataDir,
      onProgress: () => undefined,
      workerEntry: path.join(__dirname, '__fixtures__', shim),
      ...extra,
    });

    await expect(run.promise).rejects.toMatchObject({ code: 'INDEX_WORKER_CRASHED' });
    expect(fs.readdirSync(dataDir).sort()).toEqual(['graph.db']);
    expect(fs.readFileSync(path.join(dataDir, 'graph.db'), 'utf8')).toBe('previous');
    const lock = acquireWriterLock(dataDir, 'indexer');
    expect(lock).not.toBeNull();
    lock?.release();
  }, 15_000);

  it('leaves a lock held by another live index alone when its worker crashes', async () => {
    const foreign = JSON.stringify({ pid: process.pid, owner: 'indexer', since: Date.now() - 60_000, token: 'other' });
    const run = runIndexInWorker({
      root,
      dataDir,
      onProgress: () => undefined,
      workerEntry: path.join(__dirname, '__fixtures__', 'exit-only-shim.cjs'),
    });
    fs.writeFileSync(path.join(dataDir, 'writer.lock'), foreign);
    fs.writeFileSync(path.join(dataDir, 'graph.db.building'), 'theirs');
    await expect(run.promise).rejects.toMatchObject({ code: 'INDEX_WORKER_CRASHED' });
    expect(fs.readFileSync(path.join(dataDir, 'writer.lock'), 'utf8')).toBe(foreign);
    expect(fs.existsSync(path.join(dataDir, 'graph.db.building'))).toBe(true);
  }, 15_000);

  it('cancel() hard-terminates a worker that ignores it and frees the lock', async () => {
    fs.writeFileSync(path.join(dataDir, 'graph.db'), 'previous');
    const run = runIndexInWorker({
      root,
      dataDir,
      onProgress: () => undefined,
      workerEntry: path.join(__dirname, '__fixtures__', 'stuck-worker-shim.cjs'),
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(dataDir, 'graph.db.building')) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(readWriterLock(dataDir)?.owner).toBe('indexer');

    const cancelledAt = Date.now();
    run.cancel();
    await expect(run.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - cancelledAt).toBeLessThan(perfBudget(2000));
    expect(fs.readdirSync(dataDir).sort()).toEqual(['graph.db']);
    expect(readWriterLock(dataDir)).toBeNull();
  }, 15_000);
});
