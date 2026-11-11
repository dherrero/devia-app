#!/usr/bin/env node
// Code Graph parity oracle (S-44 T-507).
//
// Indexes one fixture repo (tools/code-graph/fixtures/<lang>/) twice: with the
// reference tool `codegraph` and with Devia's own engine, then compares the two
// graphs as normalised sets:
//
//   symbols  (file, qualifiedName, kind)
//   calls    (source symbol) -> (target symbol)
//   imports  (source symbol) -> (target symbol)
//
// A symbol is identified by `file_path#qualified_name#kind`. The score of each
// set is RECALL against codegraph: |ours ∩ theirs| / |theirs|. Extra edges or
// symbols that only we produce are reported but do not lower the score.
//
// Usage:
//   CODEGRAPH_ORACLE_BIN=/path/to/codegraph/dist/bin/codegraph.js \
//     node tools/code-graph/oracle.mjs --lang ts|python|java|go|dart|all [--verbose]
//
// Prints `calls: <matched>/<theirs> (<pct>%)` etc. per language and exits 1 when
// calls or imports fall under 90% or symbols under 95% (the S-44 thresholds).
//
// Both indexers run on a throwaway COPY of the fixture under the OS temp dir, so
// codegraph never writes `.codegraph/` into this repo. codegraph runs with a
// temp HOME and telemetry disabled. Its database is opened read-only.
//
// `codegraph` itself is not a dependency: build it from its sources outside this
// repo (`npm ci && npm run build`) and point CODEGRAPH_ORACLE_BIN at
// `dist/bin/codegraph.js`.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(HERE, 'fixtures');
export const LANGUAGES = ['ts', 'python', 'java', 'go', 'dart'];
export const THRESHOLDS = { calls: 90, imports: 90, symbols: 95 };

// ---------------------------------------------------------------------------
// Normalisation. Every rule here is a DELIBERATE design difference between
// codegraph and Devia's engine; nothing is dropped silently. Keep each rule
// documented with the reason it is not a defect on our side.
// ---------------------------------------------------------------------------

/**
 * Node kinds left out of the `symbols` comparison.
 *
 * - `file`: both tools emit one per file; it is the container, not a symbol,
 *   and it is compared implicitly through every other key's file_path.
 * - `import`: codegraph materialises each import STATEMENT as a node
 *   (`import:<hash>`, qualified by the module specifier). Devia models an
 *   import only as an `imports` edge, so these have no counterpart by design;
 *   the import relation itself is scored by the `imports` set.
 * - `export` (ours only): Devia stores each TS export clause as an `export`
 *   node so the resolver can follow re-exports and barrels; codegraph has no
 *   such node. Same reasoning as `import`.
 * - `module` (ours only, see MODULE_KINDS): a per-file module node that Devia
 *   adds as the qualifying scope of the file's symbols; the file node already
 *   plays that role in codegraph.
 */
export const IGNORED_SYMBOL_KINDS = new Set(['file', 'import', 'export', 'module']);

/**
 * Module-qualified names. Devia qualifies the symbols of some languages with
 * the file's module path (Python `shop.core.logging.Logger.info`), stored as a
 * per-file node of one of these kinds; codegraph qualifies only within the
 * file (`Logger::info`). The file path is already part of every key, so the
 * module prefix carries no extra identity: it is stripped from every name in
 * the file that starts with `<module qualified name>.`.
 */
export const MODULE_KINDS = new Set(['module']);

/**
 * Qualified-name separator. codegraph joins members with `::`
 * (`Logger::info`), Devia with `.` (`Logger.info`). Pure spelling: both sides
 * are folded to `.`.
 */
export function normaliseQualifiedName(name) {
  return name.split('::').join('.');
}

/**
 * `imports` edges are compared file -> file. Devia's resolution contract
 * (S-44 T-491) emits one `imports` edge per resolved module, file to file, and
 * keeps the imported NAME as a resolver-internal binding that then produces the
 * `calls`/`references` edges. codegraph models imports per language:
 *
 * - TS/JS, Python, Go, Dart: a file -> file edge per module PLUS a file ->
 *   symbol edge per imported name. The file -> symbol edges are dropped: they
 *   have no counterpart by design (their effect is scored through `calls`), and
 *   projecting them to the symbol's file would invent edges past barrels
 *   (`import { X } from './index'` is an import of index.ts, not of x.ts).
 * - Java: ONLY file -> symbol edges (`import a.b.C` -> class C; a wildcard
 *   import -> a `namespace` node). For a source file with no file -> file
 *   import at all, each file -> symbol edge is projected to file -> (the
 *   symbol's file), which is exactly what a Java import of a top-level type is.
 *
 * The SOURCE is likewise folded to its file: codegraph's Java import edges
 * leave from the file's package `namespace` node, Devia's from the file node.
 * Self-edges (a file importing a symbol it defines) are dropped.
 */
function normaliseImports(rows) {
  const hasFileImport = new Set(rows.filter((r) => r.tk === 'file').map((r) => r.sf));
  const out = [];
  for (const r of rows) {
    if (r.tk === 'file' || !hasFileImport.has(r.sf)) out.push({ sourceFile: r.sf, targetFile: r.tf });
  }
  return out;
}

/**
 * codegraph SYNTHESIZES extra `calls` edges (edges.metadata.synthesizedBy, e.g.
 * `interface-impl`: interface method -> every implementation; framework
 * routers; callbacks). Devia's resolver is a port WITHOUT synthesizers (S-44
 * T-491: "SIN frameworks/, SIN synthesizers"), so these are excluded from the
 * reference set. They are counted and printed as `synthesized` so the
 * difference stays visible.
 */
export function isSynthesized(metadataJson) {
  if (!metadataJson) return false;
  try {
    const meta = JSON.parse(metadataJson);
    return typeof meta?.synthesizedBy === 'string';
  } catch {
    return false;
  }
}

/** Edge kinds that are scored. */
export const SCORED_EDGE_KINDS = ['calls', 'imports'];

// ---------------------------------------------------------------------------

function symbolKey(file, qualifiedName, kind) {
  return `${file}#${normaliseQualifiedName(qualifiedName)}#${kind}`;
}

function toPosix(p) {
  return p.split(path.sep).join('/').replace(/^\.\//, '');
}

/**
 * Reads the normalised symbol and edge sets out of a graph database (both tools
 * share the same `nodes`/`edges` schema). Opened read-only.
 */
export function readGraph(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const nodes = db.prepare('SELECT id, file_path, qualified_name, kind FROM nodes').all();
    const modulePrefixes = new Map();
    for (const n of nodes) {
      if (!MODULE_KINDS.has(n.kind)) continue;
      const file = toPosix(n.file_path);
      modulePrefixes.set(file, [...(modulePrefixes.get(file) ?? []), `${n.qualified_name}.`]);
    }
    const keyById = new Map();
    const symbols = new Set();
    for (const n of nodes) {
      const file = toPosix(n.file_path);
      let qn = n.qualified_name;
      if (!MODULE_KINDS.has(n.kind) && n.kind !== 'file') {
        const prefix = (modulePrefixes.get(file) ?? [])
          .filter((p) => qn.startsWith(p))
          .sort((a, b) => b.length - a.length)[0];
        if (prefix) qn = qn.slice(prefix.length);
      }
      const key = symbolKey(file, qn, n.kind);
      keyById.set(n.id, key);
      if (!IGNORED_SYMBOL_KINDS.has(n.kind)) symbols.add(key);
    }

    const edges = Object.fromEntries(SCORED_EDGE_KINDS.map((k) => [k, new Set()]));
    const hasMetadata = db
      .prepare('PRAGMA table_info(edges)')
      .all()
      .some((c) => c.name === 'metadata');
    let synthesized = 0;
    const rows = db
      .prepare(
        `SELECT e.kind AS kind, e.source AS source, e.target AS target,
                ${hasMetadata ? 'e.metadata' : 'NULL'} AS meta,
                s.file_path AS sf, t.kind AS tk, t.file_path AS tf
           FROM edges e
           JOIN nodes s ON s.id = e.source
           JOIN nodes t ON t.id = e.target
          WHERE e.kind IN (${SCORED_EDGE_KINDS.map(() => '?').join(',')})`,
      )
      .all(...SCORED_EDGE_KINDS);
    const fileKey = new Map();
    for (const n of nodes) if (n.kind === 'file') fileKey.set(toPosix(n.file_path), keyById.get(n.id));
    const imports = [];
    for (const r of rows) {
      if (isSynthesized(r.meta)) {
        synthesized++;
        continue;
      }
      if (r.kind === 'imports') {
        imports.push(r);
        continue;
      }
      const source = keyById.get(r.source);
      const target = keyById.get(r.target);
      if (source && target) edges[r.kind].add(`${source} -> ${target}`);
    }
    for (const e of normaliseImports(imports)) {
      const source = fileKey.get(toPosix(e.sourceFile));
      const target = fileKey.get(toPosix(e.targetFile));
      if (source && target && source !== target) edges.imports.add(`${source} -> ${target}`);
    }
    return { symbols, ...edges, synthesized };
  } finally {
    db.close();
  }
}

function score(ours, theirs) {
  const matched = [...theirs].filter((k) => ours.has(k));
  const missing = [...theirs].filter((k) => !ours.has(k)).sort();
  const extra = [...ours].filter((k) => !theirs.has(k)).sort();
  const pct = theirs.size === 0 ? 100 : (matched.length / theirs.size) * 100;
  return { matched: matched.length, theirs: theirs.size, ours: ours.size, pct, missing, extra };
}

export function compareGraphs(ours, theirs) {
  return {
    synthesized: theirs.synthesized,
    calls: score(ours.calls, theirs.calls),
    imports: score(ours.imports, theirs.imports),
    symbols: score(ours.symbols, theirs.symbols),
  };
}

export function passes(result) {
  return Object.entries(THRESHOLDS).every(([k, min]) => result[k].pct >= min);
}

export function formatResult(lang, result, verbose = false) {
  const lines = [`[${lang}]  (codegraph synthesized edges excluded: ${result.synthesized})`];
  for (const k of ['calls', 'imports', 'symbols']) {
    const r = result[k];
    const flag = r.pct >= THRESHOLDS[k] ? 'ok' : `BELOW ${THRESHOLDS[k]}%`;
    lines.push(`  ${k}: ${r.matched}/${r.theirs} (${r.pct.toFixed(1)}%) ${flag}  [ours total ${r.ours}, extra ${r.extra.length}]`);
    if (verbose) {
      for (const m of r.missing) lines.push(`    - missing ${m}`);
      for (const m of r.extra) lines.push(`    + extra   ${m}`);
    }
  }
  return lines.join('\n');
}

/** Copies a fixture to a fresh temp dir so neither indexer writes into the repo. */
export function stageFixture(lang) {
  const src = path.join(FIXTURES_DIR, lang);
  if (!fs.existsSync(src)) throw new Error(`No fixture for language "${lang}" at ${src}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `devia-oracle-${lang}-`));
  const root = path.join(work, 'repo');
  fs.cpSync(src, root, { recursive: true });
  return { work, root };
}

/** Runs codegraph on `root` and returns the path of its database. */
export function indexWithCodegraph(root, bin, work) {
  const home = path.join(work, 'home');
  fs.mkdirSync(home, { recursive: true });
  execFileSync(process.execPath, [bin, 'init', '-y', root], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEGRAPH_TELEMETRY: '0',
      DO_NOT_TRACK: '1',
      CI: '1',
      NO_COLOR: '1',
    },
    timeout: 300_000,
  });
  const db = path.join(root, '.codegraph', 'codegraph.db');
  if (!fs.existsSync(db)) throw new Error(`codegraph produced no database at ${db}`);
  return db;
}

/**
 * Runs the whole comparison for one language.
 * `indexOurs(root, dataDir)` must index `root` with Devia's engine and resolve.
 */
export async function runOracle({ lang, codegraphBin, indexOurs, keep = false }) {
  const { work, root } = stageFixture(lang);
  try {
    // Ours first: codegraph's `.codegraph/` must not be discovered by our indexer.
    const dataDir = path.join(work, 'devia');
    await indexOurs(root, dataDir);
    const oursDb = path.join(dataDir, 'graph.db');
    const theirsDb = indexWithCodegraph(root, codegraphBin, work);
    return compareGraphs(readGraph(oursDb), readGraph(theirsDb));
  } finally {
    if (!keep) fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Loads Devia's TypeScript engine through tsx (CLI use only; tests import it directly). */
async function loadOurIndexer() {
  const { register } = await import('tsx/cjs/api');
  register();
  const { createRequire } = await import('node:module');
  const require = createRequire(pathToFileURL(path.join(HERE, 'oracle.mjs')));
  const mod = require(
    path.join(HERE, '..', '..', 'src', 'main', 'features', 'code-graph', 'engine', 'indexer', 'orchestrator.ts'),
  );
  return (root, dataDir) => mod.indexProject({ root, dataDir });
}

function parseArgs(argv) {
  const args = { lang: 'all', verbose: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lang') args.lang = argv[++i];
    else if (argv[i] === '--verbose' || argv[i] === '-v') args.verbose = true;
    else if (argv[i] === '--keep') args.keep = true;
  }
  return args;
}

async function cli() {
  const args = parseArgs(process.argv.slice(2));
  const bin = process.env.CODEGRAPH_ORACLE_BIN;
  if (!bin || !fs.existsSync(bin)) {
    console.error('Set CODEGRAPH_ORACLE_BIN to a built codegraph dist/bin/codegraph.js');
    process.exit(2);
  }
  const langs = args.lang === 'all' ? LANGUAGES : [args.lang];
  for (const l of langs) {
    if (!LANGUAGES.includes(l)) {
      console.error(`Unknown --lang ${l}; expected one of ${LANGUAGES.join(', ')} or all`);
      process.exit(2);
    }
  }
  const indexOurs = await loadOurIndexer();
  let ok = true;
  for (const lang of langs) {
    const result = await runOracle({ lang, codegraphBin: bin, indexOurs, keep: args.keep });
    console.log(formatResult(lang, result, args.verbose));
    ok = passes(result) && ok;
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
