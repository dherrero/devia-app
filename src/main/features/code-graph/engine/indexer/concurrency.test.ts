import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodeGraphStore } from '../../infrastructure/code-graph-store';
import { callGraphTool, createGraphToolContext } from '../../mcp-server/graph-tools';
import { isFullIndexRunning, readWriterLock } from '../db/writer-lock';
import { runIndexInWorker } from './index-runner';
import { BUILDING_DB_FILE, GRAPH_DB_FILE, indexProject } from './orchestrator';
import { syncProject } from './sync';
import { snapshotGraph, TestProject } from './sync-test-support';

const FIXTURES = path.join(__dirname, '__fixtures__');
const workerEntry = path.join(FIXTURES, 'ts-worker-shim.cjs');
const NOTE_INDEXING = '⚠ an index is in progress; results may be slightly out of date';

let project: TestProject;
let deviaDir: string;
let dataDir: string;

beforeEach(() => {
  project = new TestProject();
  deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-conc-devia-'));
  dataDir = new CodeGraphStore(() => deviaDir).dataDir(project.root);
  fs.mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  project.dispose();
  fs.rmSync(deviaDir, { recursive: true, force: true });
});

function writeModules(count: number, from = 0): void {
  for (let i = from; i < from + count; i++) {
    const next = i + 1 < from + count ? `m${i + 1}()` : '0';
    project.write(
      `src/m${i}.ts`,
      `import { m${i + 1} } from './m${i + 1}';\nexport function m${i}(): number {\n  return ${next};\n}\n`,
    );
  }
}

function integrity(): string {
  const db = new DatabaseSync(path.join(dataDir, GRAPH_DB_FILE), { readOnly: true });
  try {
    return (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  } finally {
    db.close();
  }
}

const buildingFiles = (): string[] => fs.readdirSync(dataDir).filter((n) => n.startsWith(BUILDING_DB_FILE));

describe('readers while a full index runs', () => {
  it('three simultaneous tool calls during a worker index never fail and carry the in-progress note', async () => {
    writeModules(40);
    await indexProject({ root: project.root, dataDir });
    const store = new CodeGraphStore(() => deviaDir);
    store.saveDoc(project.root, { createdAt: 1, indexedAt: 1, autoUpdate: true });
    writeModules(400, 40);

    let parsing!: () => void;
    const started = new Promise<void>((r) => (parsing = r));
    const run = runIndexInWorker({
      root: project.root,
      dataDir,
      workerEntry,
      batchSize: 1,
      onProgress: (p) => {
        if (p.phase === 'parse' && p.filesDone >= 2) parsing();
      },
    });
    let finished = false;
    const done = run.promise.finally(() => (finished = true));
    try {
      await started;
      await readDuringIndex(() => finished);
      expect((await done).files).toBe(440);
    } finally {
      run.cancel();
      await done.catch(() => undefined);
    }
    const after = await readAll(createGraphToolContext({ deviaDir, project: project.root, log: () => undefined }));
    expect(after.every((r) => r.isError === undefined)).toBe(true);
    expect(after[1]?.content[0]?.text).not.toContain('⚠');
  }, 60_000);
});

type ToolResult = Awaited<ReturnType<typeof callGraphTool>>;

function readAll(ctx: ReturnType<typeof createGraphToolContext>): Promise<ToolResult[]> {
  return Promise.all([
    callGraphTool(ctx, 'graph_search', { query: 'm1' }),
    callGraphTool(ctx, 'graph_node', { symbol: 'm3' }),
    callGraphTool(ctx, 'graph_callers', { symbol: 'm5' }),
  ]);
}

/** Three concurrent tool calls right away, then rounds of them until the index (publish included) is over. */
async function readDuringIndex(finished: () => boolean): Promise<void> {
  const ctx = createGraphToolContext({ deviaDir, project: project.root, log: () => undefined });
  const text = (r: ToolResult): string => r.content.map((c) => c.text).join('\n');

  expect(isFullIndexRunning(dataDir)).toBe(true);
  const during = await readAll(ctx);
  for (const r of during) {
    expect(r.isError).toBeUndefined();
    expect(text(r)).not.toMatch(/SQLITE_BUSY|database is locked/i);
    expect(text(r)).toContain(NOTE_INDEXING);
  }
  expect(text(during[1] as ToolResult)).toMatch(/m3 \(function\) — src\/m3\.ts:2/);

  let rounds = 0;
  while (!finished()) {
    for (const r of await readAll(ctx)) {
      expect(r.isError).toBeUndefined();
      expect(text(r)).not.toMatch(/SQLITE_BUSY|database is locked/i);
    }
    rounds++;
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(rounds).toBeGreaterThan(0);
}

describe('writers racing each other', () => {
  it('two simultaneous syncs: one applies the change, the other is skippedBusy', async () => {
    writeModules(5);
    await indexProject({ root: project.root, dataDir });
    project.write('src/extra.ts', 'export function extra(): number {\n  return 1;\n}\n');

    const results = await Promise.all([
      syncProject({ root: project.root, dataDir }),
      syncProject({ root: project.root, dataDir }),
    ]);
    expect(results.filter((r) => r.skippedBusy)).toHaveLength(1);
    expect(results.find((r) => !r.skippedBusy)).toMatchObject({ added: 1, fullIndexRequired: false });
    expect(readWriterLock(dataDir)).toBeNull();
    expect(integrity()).toBe('ok');
  }, 30_000);

  it('cancelling a worker index mid-parse keeps the previous graph intact', async () => {
    writeModules(10);
    await indexProject({ root: project.root, dataDir });
    const before = snapshotGraph(dataDir);
    writeModules(400, 10);

    const run = runIndexInWorker({
      root: project.root,
      dataDir,
      workerEntry,
      batchSize: 1,
      onProgress: (p) => {
        if (p.phase === 'parse' && p.filesDone >= 2) run.cancel();
      },
    });
    await expect(run.promise).rejects.toMatchObject({ name: 'AbortError' });

    expect(integrity()).toBe('ok');
    expect(snapshotGraph(dataDir)).toEqual(before);
    expect(buildingFiles()).toEqual([]);
    expect(readWriterLock(dataDir)).toBeNull();
  }, 30_000);

  it('a killed index process leaves the previous graph intact, and the next start cleans its orphan .building', async () => {
    writeModules(10);
    await indexProject({ root: project.root, dataDir });
    const before = snapshotGraph(dataDir);
    writeModules(600, 10);

    const child = spawn(process.execPath, [path.join(FIXTURES, 'index-process-shim.cjs'), project.root, dataDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString();
        if (out.includes('parsing')) resolve();
      });
      child.on('exit', () => reject(new Error(`index process exited early: ${out} ${err}`)));
    });
    // SIGKILL on POSIX, TerminateProcess on Windows: no finally block or exit hook runs.
    child.kill('SIGKILL');
    await exited;

    expect(buildingFiles().length).toBeGreaterThan(0);
    expect(readWriterLock(dataDir)?.pid).toBe(child.pid);
    expect(isFullIndexRunning(dataDir)).toBe(false);
    expect(integrity()).toBe('ok');
    expect(snapshotGraph(dataDir)).toEqual(before);

    // A sync is the first writer after a restart (watcher reconcile, MCP pre-answer sync).
    const synced = await syncProject({ root: project.root, dataDir });
    expect(synced).toMatchObject({ skippedBusy: false, added: 600 });
    expect(buildingFiles()).toEqual([]);
    expect(integrity()).toBe('ok');
    expect(readWriterLock(dataDir)).toBeNull();
  }, 60_000);

  it('the next full index also starts by removing an orphan .building left by a dead process', async () => {
    writeModules(3);
    fs.writeFileSync(path.join(dataDir, BUILDING_DB_FILE), 'partial');
    fs.writeFileSync(path.join(dataDir, `${BUILDING_DB_FILE}-journal`), 'partial');
    fs.writeFileSync(
      path.join(dataDir, 'writer.lock'),
      JSON.stringify({ pid: deadPid(), owner: 'indexer', since: Date.now(), token: 'dead' }),
    );
    const r = await indexProject({ root: project.root, dataDir });
    expect(r.files).toBe(3);
    expect(fs.readdirSync(dataDir).sort()).toEqual([GRAPH_DB_FILE]);
    expect(integrity()).toBe('ok');
  }, 30_000);
});

/** The pid of a process that has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}
