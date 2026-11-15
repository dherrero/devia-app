#!/usr/bin/env node
// Code Graph performance bench (S-44 T-512).
//
//   node tools/code-graph/bench.mjs <project-path> [--json] [--keep]
//   node tools/code-graph/bench.mjs --generate <dir> [--files 10000]
//
// Measures, on a throwaway COPY of the project (the source tree is only read):
//   full index (in a worker thread, as the app runs it), graph.db size, peak RSS,
//   1-file sync (watcher path `onlyPaths`, and the MCP path: whole-tree discovery),
//   graph_explore / graph_impact through the MCP handler, overview and expand of the
//   graph view (cold = fresh use case, warm = best of 3),
// and compares them with the S-44 budgets. The graph lives under a temp `deviaDir`,
// never under ~/.devia-app. Directories the index always ignores (node_modules, .git,
// dist, …) are not copied. `--generate` writes a synthetic TypeScript project
// (default ~10k files / ~50k nodes) to benchmark a large repo.
//
// Peak RSS is the whole bench process (the worker thread shares it), so it is an
// upper bound of the worker's own memory.

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CG = path.join(HERE, '..', '..', 'src', 'main', 'features', 'code-graph');
const WORKER_SHIM = path.join(CG, 'engine', 'indexer', '__fixtures__', 'ts-worker-shim.cjs');

export const BUDGETS = {
  fullIndexMs: 90_000,
  syncOneFileMs: 500,
  exploreMs: 1000,
  overviewMs: 300,
  expandMs: 200,
  workerRssBytes: 1.5 * 1024 ** 3,
};

/** Never copied: the index ignores them anyway, and node_modules alone can be huge. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.dart_tool', '.idea', '.vscode', '__pycache__',
  '.venv', 'venv', 'vendor', 'target', 'coverage', '.next', '.angular', 'release',
]);

function loadEngine() {
  return import('tsx/cjs/api').then(({ register }) => {
    register();
    const require = createRequire(pathToFileURL(path.join(HERE, 'bench.mjs')));
    const load = (...p) => require(path.join(CG, ...p));
    return {
      runIndexInWorker: load('engine', 'indexer', 'index-runner.ts').runIndexInWorker,
      syncProject: load('engine', 'indexer', 'sync.ts').syncProject,
      openGraphDb: load('engine', 'db', 'connection.ts').openGraphDb,
      GraphQueries: load('engine', 'db', 'queries.ts').GraphQueries,
      CodeGraphStore: load('infrastructure', 'code-graph-store.ts').CodeGraphStore,
      GraphViewUseCase: load('application', 'graph-view.use-case.ts').GraphViewUseCase,
      tools: load('mcp-server', 'graph-tools.ts'),
    };
  });
}

/** Regular files, directories and symlinks (as links) only: sockets and FIFOs are left out. */
function copyProject(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) copyProject(from, to);
    } else if (entry.isFile()) fs.copyFileSync(from, to);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
  }
}

const now = () => performance.now();

async function timed(fn) {
  const start = now();
  const value = await fn();
  return { ms: now() - start, value };
}

/** Warm-up, then the best of `runs`. */
async function best(fn, runs = 3) {
  await fn();
  let ms = Infinity;
  let value;
  for (let i = 0; i < runs; i++) {
    const r = await timed(fn);
    if (r.ms < ms) ({ ms, value } = r);
  }
  return { ms, value };
}

function dirSize(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, name)).size;
  return total;
}

function mb(bytes) {
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function pickTargets(engine, dbPath) {
  const db = engine.openGraphDb(dbPath, { readonly: true });
  try {
    const top = db
      .prepare(
        `SELECT n.name AS name, n.file_path AS file, COUNT(*) AS callers FROM edges e
         JOIN nodes n ON n.id = e.target
         WHERE e.kind = 'calls' AND n.kind IN ('function', 'method')
         GROUP BY n.id ORDER BY callers DESC, n.id LIMIT 40`,
      )
      .all();
    const unique = [];
    const seen = new Set();
    for (const r of top) {
      if (seen.has(r.name) || !/^[A-Za-z_$][\w$]*$/.test(r.name)) continue;
      seen.add(r.name);
      unique.push(r);
    }
    // The file with the most incoming references (worst case: every caller is a dependent),
    // and a median one (the usual edit).
    const ranked = db
      .prepare(
        `SELECT f.path AS path, COUNT(e.id) AS refs FROM files f
         JOIN nodes n ON n.file_path = f.path LEFT JOIN edges e ON e.target = n.id AND e.kind != 'contains'
         WHERE f.is_test = 0 AND f.node_count > 1 GROUP BY f.path ORDER BY refs DESC, f.path`,
      )
      .all();
    return {
      hubs: unique.slice(0, 5),
      hubFile: ranked[0]?.path,
      typicalFile: ranked[Math.floor(ranked.length / 2)]?.path,
    };
  } finally {
    db.close();
  }
}

function biggestDir(page) {
  const dirs = page.nodes.filter((n) => n.id.startsWith('dir:'));
  // The largest subtree: its aggregated edges are the most expensive expand.
  dirs.sort((a, b) => (b.fileCount ?? 0) - (a.fileCount ?? 0) || b.childCount - a.childCount);
  return dirs[0];
}

export async function bench(projectArg, { keep = false } = {}) {
  const source = path.resolve(projectArg);
  if (!fs.statSync(source).isDirectory()) throw new Error(`${source} is not a directory`);
  const engine = await loadEngine();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bench-'));
  const root = path.join(tmp, 'project');
  const deviaDir = path.join(tmp, 'devia');
  const out = { project: source };
  try {
    const copied = await timed(() => copyProject(source, root));
    out.copyMs = copied.ms;
    const store = new engine.CodeGraphStore(() => deviaDir);
    const dataDir = store.dataDir(root);
    fs.mkdirSync(dataDir, { recursive: true });

    let peakRss = process.memoryUsage().rss;
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 50);
    const baseRss = process.memoryUsage().rss;
    let result;
    try {
      const full = await timed(
        () => engine.runIndexInWorker({ root, dataDir, workerEntry: WORKER_SHIM, onProgress: () => undefined }).promise,
      );
      result = full.value;
      out.fullIndexMs = full.ms;
    } finally {
      clearInterval(sampler);
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    out.files = result.files;
    out.nodes = result.nodes;
    out.edges = result.edges;
    out.skipped = result.skipped;
    out.peakRssBytes = peakRss;
    out.baseRssBytes = baseRss;
    out.maxRssBytes = process.resourceUsage().maxRSS * 1024;
    out.dbBytes = dirSize(dataDir);
    store.saveDoc(root, { createdAt: Date.now(), indexedAt: Date.now(), autoUpdate: true });

    const { hubs, hubFile, typicalFile } = pickTargets(engine, store.dbPath(root));
    out.hubs = hubs.map((h) => `${h.name} (${h.callers} callers)`);

    for (const [label, syncFile] of [['Typical', typicalFile], ['Hub', hubFile]]) {
      if (!syncFile) continue;
      const abs = path.join(root, ...syncFile.split('/'));
      const original = fs.readFileSync(abs, 'utf8');
      const edit = (i) => {
        const line = syncFile.endsWith('.py')
          ? `\ndef bench_added_${i}():\n    return ${i}\n`
          : syncFile.endsWith('.go')
            ? `\nfunc benchAdded${i}() int { return ${i} }\n`
            : `\nexport function benchAdded${i}(): number { return ${i}; }\n`;
        fs.writeFileSync(abs, original + line);
        const t = (Date.now() + (i + (label === 'Hub' ? 10 : 0)) * 1000) / 1000;
        fs.utimesSync(abs, t, t);
      };
      edit(1);
      const watcher = await timed(() => engine.syncProject({ root, dataDir, onlyPaths: [syncFile] }));
      edit(2);
      const mcp = await timed(() => engine.syncProject({ root, dataDir, deadlineMs: 2000 }));
      const clean = await timed(() => engine.syncProject({ root, dataDir, deadlineMs: 2000 }));
      out[`sync${label}File`] = syncFile;
      out[`sync${label}OnlyPathsMs`] = watcher.ms;
      out[`sync${label}FullTreeMs`] = mcp.ms;
      out.syncNoChangeMs = clean.ms;
    }

    const noSync = async () => ({ added: 0, modified: 0, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: false });
    const ctx = engine.tools.createGraphToolContext({ deviaDir, project: root, sync: noSync, log: () => undefined });
    const call = async (name, args) => {
      const r = await engine.tools.callGraphTool(ctx, name, args);
      if (r.isError) throw new Error(`${name} failed: ${r.content[0]?.text}`);
      return r.content[0]?.text.length ?? 0;
    };
    const query = hubs.slice(0, 4).map((h) => h.name).join(' ') || 'main';
    out.exploreQuery = query;
    out.exploreColdMs = (await timed(() => call('graph_explore', { query }))).ms;
    out.exploreMs = (await best(() => call('graph_explore', { query }))).ms;
    if (hubs[0]) out.impactMs = (await best(() => call('graph_impact', { symbol: hubs[0].name, depth: 2 }))).ms;
    out.searchMs = (await best(() => call('graph_search', { query: hubs[0]?.name ?? 'main' }))).ms;
    const realCtx = engine.tools.createGraphToolContext({ deviaDir, project: root, log: () => undefined });
    out.exploreWithSyncMs = (await timed(() => engine.tools.callGraphTool(realCtx, 'graph_explore', { query }))).ms;

    const overviewCold = await timed(() => new engine.GraphViewUseCase({ store }).overview(root));
    const view = new engine.GraphViewUseCase({ store });
    const overview = await best(() => view.overview(root));
    out.overviewColdMs = overviewCold.ms;
    out.overviewMs = overview.ms;
    out.overviewNodes = overview.value.nodes.length;
    const big = biggestDir(overview.value);
    if (big) {
      const visibleIds = overview.value.nodes.map((n) => n.id);
      out.expandTarget = big.id;
      const cold = await timed(() => new engine.GraphViewUseCase({ store }).expand(root, big.id, { visibleIds }));
      const warm = await best(() => view.expand(root, big.id, { visibleIds }));
      out.expandColdMs = cold.ms;
      out.expandMs = warm.ms;
      out.expandNodes = warm.value.nodes.length;
      out.expandTotal = warm.value.total;
    }
    return out;
  } finally {
    if (keep) process.stderr.write(`kept ${tmp}\n`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function verdicts(r) {
  const row = (label, value, budget, fmt = (v) => `${Math.round(v)} ms`) => ({
    label,
    value: value === undefined ? 'n/a' : fmt(value),
    budget: fmt(budget),
    ok: value === undefined ? undefined : value <= budget,
  });
  return [
    row('full index', r.fullIndexMs, BUDGETS.fullIndexMs),
    row('sync typical file (watcher)', r.syncTypicalOnlyPathsMs, BUDGETS.syncOneFileMs),
    row('sync typical file (MCP, whole tree)', r.syncTypicalFullTreeMs, BUDGETS.syncOneFileMs),
    row('sync hub file (watcher)', r.syncHubOnlyPathsMs, BUDGETS.syncOneFileMs),
    row('sync hub file (MCP, whole tree)', r.syncHubFullTreeMs, BUDGETS.syncOneFileMs),
    row('graph_explore (cold)', r.exploreColdMs, BUDGETS.exploreMs),
    row('graph_explore', r.exploreMs, BUDGETS.exploreMs),
    row('overview (cold)', r.overviewColdMs, BUDGETS.overviewMs),
    row('overview', r.overviewMs, BUDGETS.overviewMs),
    row('expand largest dir (cold)', r.expandColdMs, BUDGETS.expandMs),
    row('expand largest dir', r.expandMs, BUDGETS.expandMs),
    row('peak RSS (bench process)', r.peakRssBytes, BUDGETS.workerRssBytes, mb),
  ];
}

function report(r) {
  const lines = [
    `project: ${r.project}`,
    `graph: ${r.files} files, ${r.nodes} nodes, ${r.edges} edges, ${r.skipped} skipped; graph.db ${mb(r.dbBytes)}`,
    `rss: base ${mb(r.baseRssBytes)}, peak sampled ${mb(r.peakRssBytes)}, maxRSS ${mb(r.maxRssBytes)}`,
    `sync files: typical ${r.syncTypicalFile ?? 'n/a'}, hub ${r.syncHubFile ?? 'n/a'}; no-change whole-tree sync ${Math.round(r.syncNoChangeMs ?? 0)} ms`,
    `explore query: "${r.exploreQuery}"; with a real pre-answer sync ${Math.round(r.exploreWithSyncMs)} ms`,
    `graph_impact ${Math.round(r.impactMs ?? 0)} ms, graph_search ${Math.round(r.searchMs)} ms`,
    `overview ${r.overviewNodes} nodes; expand ${r.expandTarget ?? 'n/a'} → ${r.expandNodes ?? 0}/${r.expandTotal ?? 0} nodes`,
    '',
  ];
  for (const v of verdicts(r)) {
    const mark = v.ok === undefined ? '  -  ' : v.ok ? ' ok  ' : ' OVER';
    lines.push(`${mark} ${v.label.padEnd(34)} ${v.value.padStart(10)}  (budget ${v.budget})`);
  }
  return lines.join('\n');
}

// ── synthetic project ───────────────────────────────────────────────────────

/**
 * ~5 nodes per file: the file, one import, two functions and a class with a method (plus
 * the import's binding), with calls into two other modules so resolution has real work.
 */
export function generateProject(dir, files = 10_000) {
  const perDir = 100;
  const dirs = Math.ceil(files / perDir);
  for (let d = 0; d < dirs; d++) fs.mkdirSync(path.join(dir, 'src', `pkg${d}`), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n');
  const where = (i) => `pkg${Math.floor(i / perDir)}/m${i}`;
  for (let i = 0; i < files; i++) {
    const a = (i * 7 + 1) % files;
    const b = (i * 13 + 5) % files;
    const rel = (j) => {
      const from = path.posix.dirname(where(i));
      const r = path.posix.relative(from, where(j));
      return r.startsWith('.') ? r : `./${r}`;
    };
    const src = [
      `import { f${a} } from '${rel(a)}';`,
      `import { C${b} } from '${rel(b)}';`,
      '',
      `export function f${i}(x: number): number {`,
      `  return x > 3 ? f${a}(x - 1) : g${i}(x);`,
      '}',
      '',
      `function g${i}(x: number): number {`,
      `  return new C${b}().run(x);`,
      '}',
      '',
      `export class C${i} {`,
      '  run(x: number): number {',
      '    return x + 1;',
      '  }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'src', `${where(i)}.ts`), src);
  }
}

function parseArgs(argv) {
  const args = { json: false, keep: false, files: 10_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--keep') args.keep = true;
    else if (a === '--generate') args.generate = argv[++i];
    else if (a === '--files') args.files = Number(argv[++i]);
    else args.project = a;
  }
  return args;
}

async function cli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.generate) {
    const dir = path.resolve(args.generate);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) throw new Error(`${dir} is not empty`);
    generateProject(dir, args.files);
    process.stdout.write(`generated ${args.files} files in ${dir}\n`);
    return;
  }
  if (!args.project) {
    process.stderr.write('Usage: node tools/code-graph/bench.mjs <project-path> [--json] [--keep]\n       node tools/code-graph/bench.mjs --generate <dir> [--files N]\n');
    process.exitCode = 2;
    return;
  }
  const r = await bench(args.project, { keep: args.keep });
  process.stdout.write(`${args.json ? JSON.stringify(r, null, 2) : report(r)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}
