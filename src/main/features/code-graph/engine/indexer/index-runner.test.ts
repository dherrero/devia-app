import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IndexProgress } from '../../../../../shared/domain/code-graph';
import { readWriterLock } from '../db/writer-lock';
import { runIndexInWorker } from './index-runner';

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

  it('cancel() terminates the worker quickly and keeps the previous graph.db', async () => {
    for (let i = 0; i < 400; i++)
      write(`src/m${i}.ts`, `export function f${i}(x: number): number {\n  return x + ${i};\n}\n`);
    fs.writeFileSync(path.join(dataDir, 'graph.db'), 'previous');

    let cancelledAt = 0;
    const run = runIndexInWorker({
      root,
      dataDir,
      workerEntry,
      onProgress: () => {
        if (cancelledAt === 0) {
          cancelledAt = Date.now();
          run.cancel();
        }
      },
    });

    await expect(run.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelledAt).toBeGreaterThan(0);
    expect(Date.now() - cancelledAt).toBeLessThan(2000);
    expect(fs.readdirSync(dataDir).sort()).toEqual(['graph.db']);
    expect(fs.readFileSync(path.join(dataDir, 'graph.db'), 'utf8')).toBe('previous');
    expect(readWriterLock(dataDir)).toBeNull();
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
    expect(Date.now() - cancelledAt).toBeLessThan(2000);
    expect(fs.readdirSync(dataDir).sort()).toEqual(['graph.db']);
    expect(readWriterLock(dataDir)).toBeNull();
  }, 15_000);
});
