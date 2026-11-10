import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireWriterLock } from '../engine/db/writer-lock';
import { indexProject } from '../engine/indexer/orchestrator';
import { syncProject, type SyncOptions, type SyncResult } from '../engine/indexer/sync';
import { snapshotGraph, TestProject } from '../engine/indexer/sync-test-support';
import { CodeGraphStore } from '../infrastructure/code-graph-store';
import { callGraphTool, createGraphToolContext, GRAPH_TOOLS, type GraphToolContext, type GraphToolDeps } from './graph-tools';
import { MAX_OUTPUT_CHARS } from './format';
import { SERVER_INSTRUCTIONS } from './server-instructions';

const chain = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => {
    const n = from + i;
    return n === to
      ? `export function c${n}(): number {\n  return ${n};\n}\n`
      : `export function c${n}(): number {\n  return c${n + 1}();\n}\n`;
  }).join('');

const bigBody = Array.from({ length: 390 }, (_, i) => `  const value${i} = 'padding padding padding padding padding padding padding padding';`).join('\n');

const FILES: Record<string, string> = {
  'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
  'src/math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n',
  'src/calc.ts':
    "import { add } from './math';\n\nexport class Calculator {\n  sum(xs: number[]): number {\n    return sumAll(xs);\n  }\n}\n\nexport function sumAll(xs: number[]): number {\n  return xs.reduce((acc, x) => add(acc, x), 0);\n}\n\nexport function total(xs: number[]): number {\n  return sumAll(xs);\n}\n",
  'src/calc.test.ts': "import { total } from './calc';\n\nexport function checkTotal(): boolean {\n  return total([1, 2]) === 3;\n}\n",
  'src/ui/a.ts': "export function render(): string {\n  return 'a';\n}\n",
  'src/ui/b.ts': "export function render(): string {\n  return 'b';\n}\n",
  'src/chain.ts': chain(0, 5),
  'src/big.ts': `export function huge(): void {\n${bigBody}\n}\n`,
  'py/util.py': 'def helper():\n    return 1\n\n\ndef run():\n    return helper()\n',
  'go/main.go': 'package main\n\nfunc Hello() string {\n\treturn "hi"\n}\n\nfunc main() {\n\tHello()\n}\n',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src/many/m${i}.ts`, `export function dup(): number {\n  return ${i};\n}\n`])),
  'src/many/caller.ts': "import { dup } from './m0';\n\nexport function useDup(): number {\n  return dup();\n}\n",
};

interface Fixture {
  project: TestProject;
  deviaDir: string;
  dataDir: string;
  store: CodeGraphStore;
  dispose(): void;
}

async function buildFixture(files: Record<string, string> = FILES): Promise<Fixture> {
  const project = new TestProject();
  project.writeAll(files);
  const deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-devia-'));
  const store = new CodeGraphStore(() => deviaDir);
  const dataDir = store.dataDir(project.root);
  fs.mkdirSync(dataDir, { recursive: true });
  await indexProject({ root: project.root, dataDir });
  store.saveDoc(project.root, { createdAt: 1, indexedAt: Date.UTC(2026, 10, 1), autoUpdate: true });
  return {
    project,
    deviaDir,
    dataDir,
    store,
    dispose() {
      project.dispose();
      fs.rmSync(deviaDir, { recursive: true, force: true });
    },
  };
}

type Result = Awaited<ReturnType<typeof callGraphTool>>;

function text(r: Result): string {
  return r.content.map((c) => c.text).join('\n');
}

function ctxFor(fx: Fixture, extra: Partial<GraphToolDeps> = {}): GraphToolContext {
  return createGraphToolContext({ deviaDir: fx.deviaDir, project: fx.project.root, log: () => undefined, ...extra });
}

const NO_SYNC = async (): Promise<SyncResult> => ({
  added: 0,
  modified: 0,
  deleted: 0,
  skippedBusy: false,
  truncated: false,
  fullIndexRequired: false,
});

describe('GRAPH_TOOLS', () => {
  it('lists the nine graph tools with exact names', () => {
    expect(GRAPH_TOOLS.map((t) => t.name)).toEqual([
      'graph_explore',
      'graph_search',
      'graph_node',
      'graph_callers',
      'graph_callees',
      'graph_impact',
      'graph_affected',
      'graph_files',
      'graph_status',
    ]);
  });

  it('never accepts a project path and never tells the agent to Read or grep', () => {
    for (const t of GRAPH_TOOLS) {
      const props = Object.keys((t.inputSchema['properties'] ?? {}) as Record<string, unknown>);
      expect(props).not.toContain('projectPath');
      expect(t.description).not.toMatch(/use Read|run grep/i);
    }
    expect(GRAPH_TOOLS.find((t) => t.name === 'graph_explore')?.description).toMatch(/first/i);
    expect(GRAPH_TOOLS.find((t) => t.name === 'graph_explore')?.description).toMatch(/grep/);
  });

  it('keeps the server instructions under 120 words and names graph_explore first', () => {
    expect(SERVER_INSTRUCTIONS.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(120);
    expect(SERVER_INSTRUCTIONS).toMatch(/graph_explore/);
    expect(SERVER_INSTRUCTIONS).toMatch(/graph_impact/);
    expect(SERVER_INSTRUCTIONS).toMatch(/graph_affected/);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/use Read|run grep/i);
  });
});

describe('callGraphTool on an indexed multi-language project', () => {
  let fx: Fixture;
  let ctx: GraphToolContext;

  beforeAll(async () => {
    fx = await buildFixture();
    ctx = ctxFor(fx, { sync: NO_SYNC });
  }, 60_000);

  afterAll(() => fx.dispose());

  it('graph_search lists hits with kind, signature and path:line', async () => {
    const r = await callGraphTool(ctx, 'graph_search', { query: 'add' });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/`add` \(function\) — src\/math\.ts:1/);
    expect(text(r)).toContain('add(a: number, b: number): number');
  });

  it('graph_search honours kinds and clamps limit to 50', async () => {
    const classes = text(await callGraphTool(ctx, 'graph_search', { query: 'Calculator', kinds: ['class'] }));
    expect(classes).toContain('`Calculator` (class) — src/calc.ts:3');
    expect(classes).not.toContain('(method)');
    const many = text(await callGraphTool(ctx, 'graph_search', { query: 'value', limit: 500 }));
    expect(many.split('\n').filter((l) => l.startsWith('- ')).length).toBeLessThanOrEqual(50);
  });

  it('graph_search with no hits answers with guidance', async () => {
    const r = await callGraphTool(ctx, 'graph_search', { query: 'zzzqqqnothing' });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/No symbols match `zzzqqqnothing`/);
  });

  it('graph_node returns the body, callers and callees', async () => {
    const t = text(await callGraphTool(ctx, 'graph_node', { symbol: 'sumAll' }));
    expect(t).toContain('### sumAll (function) — src/calc.ts:9');
    expect(t).toContain('xs.reduce((acc, x) => add(acc, x), 0)');
    expect(t).toMatch(/Callers: .*Calculator\.sum \(src\/calc\.ts:4\)/);
    expect(t).toMatch(/Callers: .*total \(src\/calc\.ts:13\)/);
    expect(t).toMatch(/Callees: .*add \(src\/math\.ts:1\)/);
  });

  it('graph_node on an unknown symbol is success-shaped with similar names', async () => {
    const r = await callGraphTool(ctx, 'graph_node', { symbol: 'Calculatr' });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/No symbol named `Calculatr`/);
    expect(text(r)).toMatch(/Similar names: .*Calculator \(src\/calc\.ts:3\)/);
  });

  it('graph_node on a file that is not indexed says so', async () => {
    const r = await callGraphTool(ctx, 'graph_node', { symbol: 'src/missing.ts' });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/No indexed file or symbol `src\/missing\.ts`/);
  });

  it('graph_node shows an indexed file with its members', async () => {
    const t = text(await callGraphTool(ctx, 'graph_node', { symbol: 'src/math.ts' }));
    expect(t).toContain('(file) — src/math.ts:1');
    expect(t).toMatch(/Members: .*add \(function\)/);
  });

  it('graph_node lists every overload of an ambiguous name', async () => {
    const t = text(await callGraphTool(ctx, 'graph_node', { symbol: 'render' }));
    expect(t).toContain('render — 2 matches');
    expect(t).toContain('src/ui/a.ts:1');
    expect(t).toContain('src/ui/b.ts:1');
  });

  it('graph_callers groups by depth and clamps depth to 3', async () => {
    const t = text(await callGraphTool(ctx, 'graph_callers', { symbol: 'c5', depth: 99 }));
    expect(t).toContain('## Callers of `c5` (function) — src/chain.ts:16');
    expect(t).toContain('depth clamped to 3');
    expect(t).toMatch(/### Depth 1\n- c4 \(src\/chain\.ts:13\)/);
    expect(t).toMatch(/### Depth 3\n- c2 \(src\/chain\.ts:7\)/);
    expect(t).not.toContain('c1 (');
  });

  it('graph_callees follows calls', async () => {
    const t = text(await callGraphTool(ctx, 'graph_callees', { symbol: 'total' }));
    expect(t).toContain('## Callees of `total` (function) — src/calc.ts:13');
    expect(t).toMatch(/### Depth 1\n- sumAll \(src\/calc\.ts:9\)/);
    const two = text(await callGraphTool(ctx, 'graph_callees', { symbol: 'total', depth: 2 }));
    expect(two).toMatch(/### Depth 2\n- add \(src\/math\.ts:1\)/);
  });

  it('graph_callers shows the first 8 overloads fully and the rest as file:line', async () => {
    const t = text(await callGraphTool(ctx, 'graph_callers', { symbol: 'dup' }));
    expect(t).toContain('`dup` — 10 matches');
    expect(t.match(/## Callers of `dup`/g)?.length).toBe(8);
    expect(t).toMatch(/2 more matches not expanded: src\/many\/m\d\.ts:1, src\/many\/m\d\.ts:1/);
    expect(t).toContain('- useDup (src/many/caller.ts:3)');
  });

  it('graph_impact lists symbols by depth and the files to touch, depth clamped to 4', async () => {
    const t = text(await callGraphTool(ctx, 'graph_impact', { symbol: 'c5', depth: 10 }));
    expect(t).toContain('depth clamped to 4');
    expect(t).toContain('### Depth 4');
    expect(t).toContain('c1 (function) — src/chain.ts:4');
    expect(t).not.toContain('c0 (function)');
    const add = text(await callGraphTool(ctx, 'graph_impact', { symbol: 'add' }));
    expect(add).toMatch(/Files to touch \(\d+\):\n(- .*\n)*- src\/calc\.ts/);
    expect(add).toMatch(/Tests that depend on it \(1\):\n- src\/calc\.test\.ts/);
    expect(add).toContain('- src/calc.ts (file)');
  });

  it('graph_explore with a bag of two symbols returns the flow and sources', async () => {
    const t = text(await callGraphTool(ctx, 'graph_explore', { query: 'total add' }));
    expect(t).toContain('## Flow');
    expect(t).toContain('total (src/calc.ts:13) → sumAll (src/calc.ts:9) → add (src/math.ts:1)');
    expect(t).toContain('### src/math.ts');
  });

  it('graph_files filters by path prefix and glob, grouped by directory', async () => {
    const ui = text(await callGraphTool(ctx, 'graph_files', { path: 'src/ui' }));
    expect(ui).toContain('### src/ui/');
    expect(ui).toMatch(/- a\.ts \(typescript, 1 symbols?\)/);
    expect(ui).not.toContain('math.ts');
    const py = text(await callGraphTool(ctx, 'graph_files', { pattern: '*.py' }));
    expect(py).toMatch(/### py\/\n- util\.py \(python, \d+ symbols\)/);
    expect(py).not.toContain('.ts (');
    const deep = text(await callGraphTool(ctx, 'graph_files', { pattern: 'src/**/m*.ts' }));
    expect(deep).toContain('m9.ts');
    expect(deep).toContain('math.ts');
    expect(deep).not.toContain('calc.ts');
  });

  it('graph_files with an unknown prefix says nothing is indexed there', async () => {
    const r = await callGraphTool(ctx, 'graph_files', { path: 'nowhere' });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/No indexed files under `nowhere`/);
  });

  it('graph_affected maps files, tests and unknown inputs', async () => {
    const t = text(await callGraphTool(ctx, 'graph_affected', { files: ['src/math.ts', 'notes/readme.md'] }));
    expect(t).toMatch(/Files affected \(\d+\):\n(- .*\n)*- src\/calc\.ts/);
    expect(t).toMatch(/Tests to run \(1\):\n- src\/calc\.test\.ts/);
    expect(t).toMatch(/Not in the graph \(1\): notes\/readme\.md/);
  });

  it('graph_affected accepts an absolute path inside the project', async () => {
    const t = text(await callGraphTool(ctx, 'graph_affected', { files: [fx.project.abs('src/math.ts')] }));
    expect(t).toContain('- src/calc.ts');
  });

  it('graph_status reports counts, languages and indexedAt', async () => {
    const r = await callGraphTool(ctx, 'graph_status', {});
    const t = text(r);
    expect(r.isError).toBeUndefined();
    expect(t).toMatch(/Files: \d+/);
    expect(t).toMatch(/typescript \d+/);
    expect(t).toMatch(/python 1/);
    expect(t).toMatch(/go 1/);
    expect(t).toContain('Indexed at: 2026-11-01');
  });

  it('caps the output at 24 000 characters on a line boundary', async () => {
    const t = text(await callGraphTool(ctx, 'graph_node', { symbol: 'huge' }));
    expect(t.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(t).toMatch(/… output truncated \(\d+ more lines\) — narrow the query$/);
  });

  it.each([
    ['graph_node', { symbol: 42 }],
    ['graph_node', {}],
    ['graph_search', { query: '' }],
    ['graph_search', { query: 'add', kinds: ['bogus'] }],
    ['graph_search', { query: 'add', limit: 'ten' }],
    ['graph_callers', { symbol: 'add', depth: '2' }],
    ['graph_explore', { query: ['add'] }],
    ['graph_affected', { files: 'src/math.ts' }],
    ['graph_affected', { files: [] }],
    ['graph_files', { pattern: 7 }],
  ])('%s with invalid arguments %j answers with a usage line', async (name, args) => {
    const r = await callGraphTool(ctx, name, args);
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain(`Usage: ${name}`);
  });

  it('accepts missing arguments for tools that need none', async () => {
    const r = await callGraphTool(ctx, 'graph_status', undefined);
    expect(text(r)).toMatch(/Files: \d+/);
  });

  it.each([
    ['graph_affected', { files: ['../../etc/passwd'] }],
    ['graph_affected', { files: ['/etc/passwd'] }],
    ['graph_files', { path: '../' }],
  ])('%s refuses a path outside the project: %j', async (name, args) => {
    const r = await callGraphTool(ctx, name, args);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^PATH_REFUSED: /);
  });
});

describe('callGraphTool guidance without a usable graph', () => {
  let deviaDir: string;
  let project: TestProject;

  beforeEach(() => {
    deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-empty-'));
    project = new TestProject();
    project.write('src/a.ts', 'export const a = 1;\n');
  });

  afterEach(() => {
    project.dispose();
    fs.rmSync(deviaDir, { recursive: true, force: true });
  });

  it('answers every tool with not-indexed guidance and never syncs', async () => {
    const sync = vi.fn(NO_SYNC);
    const ctx = createGraphToolContext({ deviaDir, project: project.root, sync, log: () => undefined });
    for (const name of ['graph_status', 'graph_search', 'graph_explore']) {
      const r = await callGraphTool(ctx, name, { query: 'a' });
      expect(r.isError).toBeUndefined();
      expect(text(r)).toMatch(/the user has not indexed this project in Devia; use normal search tools; do not retry graph tools/);
    }
    expect(sync).not.toHaveBeenCalled();
  });

  it('answers with the disabled guidance when agent access is off', async () => {
    const fx = await buildFixture({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      fx.store.saveDoc(fx.project.root, { createdAt: 1, indexedAt: 1, autoUpdate: true, agentAccess: false });
      const sync = vi.fn(NO_SYNC);
      const r = await callGraphTool(ctxFor(fx, { sync }), 'graph_search', { query: 'a' });
      expect(r.isError).toBeUndefined();
      expect(text(r)).toMatch(/graph access is disabled for this project by the user/);
      expect(sync).not.toHaveBeenCalled();
    } finally {
      fx.dispose();
    }
  });
});

describe('callGraphTool freshness', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await buildFixture({
      'tsconfig.json': '{ "compilerOptions": {} }\n',
      'src/a.ts': 'export function alpha(): number {\n  return 1;\n}\n',
    });
  }, 60_000);

  afterEach(() => fx.dispose());

  it('syncs before answering, so a symbol written to disk is found right away', async () => {
    const ctx = ctxFor(fx);
    fx.project.write('src/fresh.ts', 'export function freshlyAdded(): number {\n  return 2;\n}\n');
    const t = text(await callGraphTool(ctx, 'graph_search', { query: 'freshlyAdded' }));
    expect(t).toContain('`freshlyAdded` (function) — src/fresh.ts:1');
    expect(t).not.toContain('⚠');
  });

  it('runs one sync for two calls within 1.5 s and syncs again afterwards', async () => {
    let now = 10_000;
    const sync = vi.fn((o: SyncOptions) => syncProject(o));
    const ctx = ctxFor(fx, { sync, now: () => now });
    await callGraphTool(ctx, 'graph_search', { query: 'alpha' });
    now += 1000;
    await callGraphTool(ctx, 'graph_node', { symbol: 'alpha' });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0]?.[0]).toMatchObject({ root: fx.project.root, dataDir: fx.dataDir, deadlineMs: 2000 });
    now += 600;
    await callGraphTool(ctx, 'graph_status', {});
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent calls onto one in-flight sync', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const sync = vi.fn(async (o: SyncOptions) => {
      await gate;
      return syncProject(o);
    });
    const ctx = ctxFor(fx, { sync });
    const calls = [
      callGraphTool(ctx, 'graph_search', { query: 'alpha' }),
      callGraphTool(ctx, 'graph_node', { symbol: 'alpha' }),
      callGraphTool(ctx, 'graph_status', {}),
    ];
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await Promise.all(calls);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(text(results[0] as Result)).toContain('`alpha` (function)');
  });

  it('answers from the existing graph with a note and leaves the DB untouched while a full index runs', async () => {
    const lock = acquireWriterLock(fx.dataDir, 'indexer');
    expect(lock).not.toBeNull();
    try {
      const before = snapshotGraph(fx.dataDir);
      fx.project.write('src/a.ts', 'export function alphaRenamed(): number {\n  return 1;\n}\n');
      const sync = vi.fn((o: SyncOptions) => syncProject(o));
      const t = text(await callGraphTool(ctxFor(fx, { sync }), 'graph_search', { query: 'alpha' }));
      expect(t).toContain('`alpha` (function)');
      expect(t.split('\n').at(-1)).toBe('⚠ an index is in progress; results may be slightly out of date');
      expect(sync).not.toHaveBeenCalled();
      expect(snapshotGraph(fx.dataDir)).toEqual(before);
    } finally {
      lock?.release();
    }
  });

  it('notes a skipped sync when another process holds the writer lock', async () => {
    const lock = acquireWriterLock(fx.dataDir, 'sync');
    try {
      const t = text(await callGraphTool(ctxFor(fx), 'graph_search', { query: 'alpha' }));
      expect(t).toContain('`alpha` (function)');
      expect(t).toContain('⚠ an index is in progress; results may be slightly out of date');
    } finally {
      lock?.release();
    }
  });

  it('notes that a full re-index is required after a tsconfig change', async () => {
    fx.project.write('tsconfig.json', '{ "compilerOptions": { "baseUrl": "." } }\n');
    const t = text(await callGraphTool(ctxFor(fx), 'graph_search', { query: 'alpha' }));
    expect(t).toContain('`alpha` (function)');
    expect(t).toContain('⚠ the graph needs a full re-index from Devia (Update button); results may be stale');
  });

  it('notes a truncated sync as catching up', async () => {
    const sync = async (): Promise<SyncResult> => ({ ...(await NO_SYNC()), truncated: true });
    const t = text(await callGraphTool(ctxFor(fx, { sync }), 'graph_search', { query: 'alpha' }));
    expect(t).toContain('⚠ graph is catching up with recent edits');
  });

  it('answers from the current graph with a note when the sync throws', async () => {
    const log = vi.fn();
    const sync = async (): Promise<SyncResult> => {
      throw new Error('disk on fire');
    };
    const r = await callGraphTool(ctxFor(fx, { sync, log }), 'graph_search', { query: 'alpha' });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('`alpha` (function)');
    expect(text(r)).toMatch(/⚠ .*could not refresh/);
    expect(log.mock.calls.join('\n')).toContain('disk on fire');
  });

  it('graph_status reports a running index and the re-index flag', async () => {
    fx.project.write('tsconfig.json', '{ "compilerOptions": { "baseUrl": "." } }\n');
    const t = text(await callGraphTool(ctxFor(fx), 'graph_status', {}));
    expect(t).toMatch(/Full re-index required: yes/);
    const lock = acquireWriterLock(fx.dataDir, 'indexer');
    try {
      const running = text(await callGraphTool(ctxFor(fx), 'graph_status', {}));
      expect(running).toMatch(/Index running: yes/);
    } finally {
      lock?.release();
    }
  });

  it('reports a genuine failure with isError and a retry hint', async () => {
    for (const f of ['graph.db', 'graph.db-wal', 'graph.db-shm']) fs.rmSync(path.join(fx.dataDir, f), { force: true });
    fs.mkdirSync(path.join(fx.dataDir, 'graph.db'));
    const r = await callGraphTool(ctxFor(fx, { sync: NO_SYNC }), 'graph_search', { query: 'alpha' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/retry once/i);
  });
});
