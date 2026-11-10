import * as fs from 'node:fs';
import * as path from 'node:path';
import { NODE_KINDS, type GraphNode, type NodeKind } from '../../../../shared/domain/code-graph';
import { isPathContained } from '../../../shared/workspace-paths';
import { openGraphDb } from '../engine/db/connection';
import { GraphQueries } from '../engine/db/queries';
import { isFullIndexRunning, readWriterLock } from '../engine/db/writer-lock';
import { getAffected } from '../engine/graph/affected';
import { exploreSymbols } from '../engine/graph/explore';
import { getExploreOutputBudget } from '../engine/graph/explore-budget';
import { getNodeDetail } from '../engine/graph/node-detail';
import { PathRefusedError } from '../engine/graph/source-reader';
import { lookupSymbol } from '../engine/graph/symbol-lookup';
import { getCallees, getCallers, getImpact, type TraversalHit } from '../engine/graph/traversal';
import type { SyncOptions, SyncResult } from '../engine/indexer/sync';
import { splitIdentifier } from '../engine/search/query-parser';
import { searchSymbols } from '../engine/search/search';
import { CodeGraphStore } from '../infrastructure/code-graph-store';
import { capOutput, globToRegExp, heading, location, MAX_OUTPUT_CHARS, ref } from './format';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface GraphToolResult {
  content: { type: 'text'; text: string }[];
  isError?: true;
}

export interface GraphToolDeps {
  deviaDir: string;
  /** Absolute project root the server is bound to; agents cannot point it elsewhere. */
  project: string;
  now?: () => number;
  sync?: (opts: SyncOptions) => Promise<SyncResult>;
  log?: (line: string) => void;
}

interface Freshness {
  lastFinishedAt: number | undefined;
  lastNotes: string[];
  lastResult: SyncResult | undefined;
  inflight: Promise<string[]> | undefined;
}

export interface GraphToolContext {
  readonly project: string;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly store: CodeGraphStore;
  readonly now: () => number;
  readonly sync: (opts: SyncOptions) => Promise<SyncResult>;
  readonly log: (line: string) => void;
  readonly freshness: Freshness;
}

const SYNC_DEADLINE_MS = 2000;
const SYNC_THROTTLE_MS = 1500;
const MAX_CALL_DEPTH = 3;
const MAX_IMPACT_DEPTH = 4;
const DEFAULT_IMPACT_DEPTH = 2;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const MAX_FILES_LISTED = 200;
const MAX_EXPANDED = 8;
const SUGGESTIONS = 5;
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyw|java|go|dart)$/;

export const NO_GRAPH_TEXT =
  'No code graph: the user has not indexed this project in Devia; use normal search tools; do not retry graph tools in this session.';
const FIRST_INDEX_TEXT =
  'The first index of this project is running in Devia; graph tools will answer once it finishes. Use normal search tools meanwhile.';
const DISABLED_TEXT =
  'graph access is disabled for this project by the user. Use normal search tools; do not retry graph tools in this session.';

const NOTE_INDEXING = 'an index is in progress; results may be slightly out of date';
const NOTE_REINDEX = 'the graph needs a full re-index from Devia (Update button); results may be stale';
const NOTE_CATCHING_UP = 'graph is catching up with recent edits; very recent changes may be missing';
const NOTE_SYNC_FAILED = 'could not refresh the graph before answering; results may be out of date';

const sym = (desc: string): Record<string, unknown> => ({
  type: 'string',
  description: `${desc} Accepts a name, Class.method, a qualified-name suffix, file.ts#name or a node id.`,
});

const depthProp = (max: number, def: number): Record<string, unknown> => ({
  type: 'number',
  description: `Levels to follow (default ${def}, max ${max}).`,
});

export const GRAPH_TOOLS: McpToolDef[] = [
  {
    name: 'graph_explore',
    description:
      'PRIMARY TOOL: call it FIRST, instead of grep/find, for how code works, a flow, a bug or the code you are about to change. Pass a bag of exact symbol names separated by spaces; one call returns their source grouped by file plus the call path between them.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Exact symbol names separated by spaces, e.g. "loadConfig AppServer.start src/db.ts#connect".',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'graph_search',
    description:
      'Find symbol definitions when you only know part of a name. Replaces grep/find for locating code: each hit has kind, signature and path:line (no source).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name, part of a name or words from a signature/docstring.' },
        kinds: { type: 'array', items: { type: 'string', enum: [...NODE_KINDS] }, description: 'Only these node kinds.' },
        limit: { type: 'number', description: `Max hits (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).` },
      },
      required: ['query'],
    },
  },
  {
    name: 'graph_node',
    description:
      "One symbol's full source, signature, members, callers and callees in one call. An ambiguous name returns every overload.",
    inputSchema: {
      type: 'object',
      properties: { symbol: sym('The symbol to show.') },
      required: ['symbol'],
    },
  },
  {
    name: 'graph_callers',
    description:
      'Who calls a symbol, grouped by depth, including calls through base methods it overrides (marked "via dispatch"). Replaces grep for call sites.',
    inputSchema: {
      type: 'object',
      properties: { symbol: sym('The called symbol.'), depth: depthProp(MAX_CALL_DEPTH, 1) },
      required: ['symbol'],
    },
  },
  {
    name: 'graph_callees',
    description:
      'What a symbol calls, grouped by depth, including overriding implementations (marked "via dispatch"). Replaces reading a body to follow a flow.',
    inputSchema: {
      type: 'object',
      properties: { symbol: sym('The calling symbol.'), depth: depthProp(MAX_CALL_DEPTH, 1) },
      required: ['symbol'],
    },
  },
  {
    name: 'graph_impact',
    description:
      'Run BEFORE changing a symbol, especially a public signature: every symbol that depends on it, by depth, and the unique files you will have to edit.',
    inputSchema: {
      type: 'object',
      properties: { symbol: sym('The symbol you plan to change.'), depth: depthProp(MAX_IMPACT_DEPTH, DEFAULT_IMPACT_DEPTH) },
      required: ['symbol'],
    },
  },
  {
    name: 'graph_affected',
    description:
      'Which other files and which tests depend on the given project files. Use it before changing public code and after editing, to pick what to re-check and which tests to run.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Changed files, relative to the project root.' },
      },
      required: ['files'],
    },
  },
  {
    name: 'graph_files',
    description:
      'Indexed source files with language and symbol counts, grouped by directory. Replaces find/ls for project structure.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory prefix relative to the project root, e.g. "src/api".' },
        pattern: {
          type: 'string',
          description: 'Glob: * stays within a path segment, ** spans segments. Without a "/" it matches the file name.',
        },
      },
    },
  },
  {
    name: 'graph_status',
    description: 'Whether the code graph is ready: file/symbol counts, languages, last index time and pending re-index or running index.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const USAGE: Record<string, string> = {
  graph_explore: 'Usage: graph_explore { "query": "SymbolA SymbolB Class.method" } (exact symbol names separated by spaces)',
  graph_search: `Usage: graph_search { "query": "part of a name", "kinds"?: ["function", "class", ...], "limit"?: 1-${MAX_SEARCH_LIMIT} }. Valid kinds: ${NODE_KINDS.join(', ')}`,
  graph_node: 'Usage: graph_node { "symbol": "name | Class.method | file.ts#name" }',
  graph_callers: `Usage: graph_callers { "symbol": "name | Class.method | file.ts#name", "depth"?: 1-${MAX_CALL_DEPTH} }`,
  graph_callees: `Usage: graph_callees { "symbol": "name | Class.method | file.ts#name", "depth"?: 1-${MAX_CALL_DEPTH} }`,
  graph_impact: `Usage: graph_impact { "symbol": "name | Class.method | file.ts#name", "depth"?: 1-${MAX_IMPACT_DEPTH} }`,
  graph_affected: 'Usage: graph_affected { "files": ["src/a.ts", "src/b.py"] } (paths relative to the project root)',
  graph_files: 'Usage: graph_files { "path"?: "src/dir", "pattern"?: "*.ts" | "src/**/*.test.ts" }',
  graph_status: 'Usage: graph_status {}',
};

const TOOL_NAMES = new Set(GRAPH_TOOLS.map((t) => t.name));

export function isGraphTool(name: string): boolean {
  return TOOL_NAMES.has(name);
}

export function createGraphToolContext(deps: GraphToolDeps): GraphToolContext {
  const store = new CodeGraphStore(() => deps.deviaDir);
  return {
    project: deps.project,
    dataDir: store.dataDir(deps.project),
    dbPath: store.dbPath(deps.project),
    store,
    now: deps.now ?? Date.now,
    sync: deps.sync ?? defaultSync,
    log: deps.log ?? ((line) => process.stderr.write(`${line}\n`)),
    freshness: { lastFinishedAt: undefined, lastNotes: [], lastResult: undefined, inflight: undefined },
  };
}

// The sync path pulls in web-tree-sitter and the grammars; loading it lazily keeps startup fast.
async function defaultSync(opts: SyncOptions): Promise<SyncResult> {
  const { syncProject } = await import('../engine/indexer/sync');
  return syncProject(opts);
}

function notesFor(r: SyncResult): string[] {
  const notes: string[] = [];
  if (r.fullIndexRequired) notes.push(NOTE_REINDEX);
  if (r.skippedBusy) notes.push(NOTE_INDEXING);
  if (r.truncated) notes.push(NOTE_CATCHING_UP);
  return notes;
}

async function runSync(ctx: GraphToolContext): Promise<string[]> {
  const f = ctx.freshness;
  try {
    const r = await ctx.sync({ root: ctx.project, dataDir: ctx.dataDir, deadlineMs: SYNC_DEADLINE_MS });
    f.lastResult = r;
    f.lastNotes = notesFor(r);
  } catch (e) {
    ctx.log(`[devia-code-graph] sync failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    f.lastNotes = (e as { code?: unknown }).code === 'GRAPH_NOT_FOUND' ? [] : [NOTE_SYNC_FAILED];
  } finally {
    f.lastFinishedAt = ctx.now();
    f.inflight = undefined;
  }
  return f.lastNotes;
}

/** Throttled, coalesced sync before answering; never throws. */
function ensureFresh(ctx: GraphToolContext): Promise<string[]> {
  if (isFullIndexRunning(ctx.dataDir)) return Promise.resolve([NOTE_INDEXING]);
  const f = ctx.freshness;
  if (f.inflight) return f.inflight;
  if (f.lastFinishedAt !== undefined && ctx.now() - f.lastFinishedAt < SYNC_THROTTLE_MS) {
    return Promise.resolve(f.lastNotes);
  }
  f.inflight = runSync(ctx);
  return f.inflight;
}

// ── argument parsing ──────────────────────────────────────────────────────

type Args = Record<string, unknown>;
type Parsed<T> = { ok: true; value: T } | { ok: false };
const bad = { ok: false } as const;
const good = <T>(value: T): Parsed<T> => ({ ok: true, value });

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function optionalNumber(v: unknown): Parsed<number | undefined> {
  if (v === undefined || v === null) return good(undefined);
  return typeof v === 'number' && Number.isFinite(v) ? good(v) : bad;
}

function optionalString(v: unknown): Parsed<string | undefined> {
  if (v === undefined || v === null) return good(undefined);
  return typeof v === 'string' ? good(v) : bad;
}

interface Depth {
  depth: number;
  note?: string;
}

function clampDepth(requested: number | undefined, def: number, max: number): Depth {
  if (requested === undefined) return { depth: def };
  const d = Math.floor(requested);
  if (d > max) return { depth: max, note: `depth clamped to ${max} (requested ${requested})` };
  if (d < 1) return { depth: 1, note: `depth clamped to 1 (requested ${requested})` };
  return { depth: d };
}

/** Root-relative `/` path of `input`; throws PathRefusedError when it leaves the project. */
function projectRelative(root: string, input: string): string {
  if (input.includes('\0')) throw new PathRefusedError(input);
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, input);
  if (!isPathContained(abs, rootAbs)) throw new PathRefusedError(input);
  return path.relative(rootAbs, abs).split(path.sep).join('/');
}

// ── tool bodies ───────────────────────────────────────────────────────────

interface RunEnv {
  ctx: GraphToolContext;
  notes: string[];
}

interface Tool<T> {
  parse(args: Args, ctx: GraphToolContext): Parsed<T>;
  run(q: GraphQueries, value: T, env: RunEnv): { text: string; maxChars?: number };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function suggestions(q: GraphQueries, symbol: string): GraphNode[] {
  const base = symbol.slice(symbol.lastIndexOf('#') + 1).replace(/^.*\//, '');
  const queries = [base];
  if (base.length > 4) queries.push(base.slice(0, Math.max(3, base.length - 2)));
  for (const seg of splitIdentifier(base)) if (seg.length >= 3) queries.push(seg);
  const byId = new Map<string, GraphNode>();
  for (const query of queries) {
    for (const hit of searchSymbols(q, query, { limit: SUGGESTIONS })) {
      if (hit.node.kind !== 'file' && !byId.has(hit.node.id)) byId.set(hit.node.id, hit.node);
    }
    if (byId.size >= SUGGESTIONS) break;
  }
  return [...byId.values()].slice(0, SUGGESTIONS);
}

function similarLine(q: GraphQueries, symbol: string): string {
  const similar = suggestions(q, symbol);
  return similar.length > 0
    ? `Similar names: ${similar.map(ref).join(', ')}.`
    : 'No similar names in the graph; try graph_search with part of the name.';
}

function looksLikePath(symbol: string): boolean {
  return !symbol.includes('#') && (symbol.includes('/') || SOURCE_EXT.test(symbol));
}

function notFoundText(q: GraphQueries, symbol: string): string {
  const head = looksLikePath(symbol)
    ? `No indexed file or symbol \`${symbol}\`. A file outside the supported languages, ignored by .gitignore or not yet saved is not in the graph.`
    : `No symbol named \`${symbol}\` in the code graph.`;
  return `${head}\n${similarLine(q, symbol)}`;
}

/** Runs `section` for the first matches and lists the rest by location. */
function perMatch(q: GraphQueries, symbol: string, section: (n: GraphNode) => string): string {
  const byId = q.nodeById(symbol);
  const nodes = byId ? [byId] : lookupSymbol(q, symbol);
  if (nodes.length === 0) return notFoundText(q, symbol);
  const parts: string[] = [];
  if (nodes.length > 1) parts.push(`\`${symbol}\` — ${nodes.length} matches`);
  parts.push(...nodes.slice(0, MAX_EXPANDED).map(section));
  const rest = nodes.slice(MAX_EXPANDED);
  if (rest.length > 0) {
    parts.push(
      `${rest.length} more matches not expanded: ${rest.map(location).join(', ')} (pick one with file.ts#name or Class.method)`,
    );
  }
  return parts.join('\n\n');
}

function byDepth(hits: TraversalHit[]): string[] {
  const out: string[] = [];
  let current = 0;
  for (const h of hits) {
    if (h.depth !== current) {
      current = h.depth;
      out.push(`### Depth ${current}`);
    }
    out.push(`- ${ref(h.node)}${h.via === 'dispatch' ? ' — via dispatch' : ''}`);
  }
  return out;
}

interface SymbolDepth {
  symbol: string;
  depth: Depth;
}

function symbolDepthTool(
  max: number,
  def: number,
  run: (q: GraphQueries, v: SymbolDepth) => string,
): Tool<SymbolDepth> {
  return {
    parse(args) {
      const symbol = nonEmptyString(args['symbol']);
      const depth = optionalNumber(args['depth']);
      if (symbol === undefined || !depth.ok) return bad;
      return good({ symbol, depth: clampDepth(depth.value, def, max) });
    },
    run: (q, v) => ({ text: run(q, v) }),
  };
}

function callTool(kind: 'Callers' | 'Callees'): Tool<SymbolDepth> {
  return symbolDepthTool(MAX_CALL_DEPTH, 1, (q, { symbol, depth }) =>
    perMatch(q, symbol, (node) => {
      const find = kind === 'Callers' ? getCallers : getCallees;
      const hits = find(q, node.id, { depth: depth.depth, includeInheritance: true });
      const lines = [`## ${kind} of ${heading(node)}`];
      if (depth.note) lines.push(`(${depth.note})`);
      if (hits.length === 0) lines.push(`No ${kind.toLowerCase()} in the graph within depth ${depth.depth}.`);
      else lines.push(...byDepth(hits));
      return lines.join('\n');
    }),
  );
}

const impactTool = symbolDepthTool(MAX_IMPACT_DEPTH, DEFAULT_IMPACT_DEPTH, (q, { symbol, depth }) =>
  perMatch(q, symbol, (node) => {
    const impact = getImpact(q, node.id, { depth: depth.depth });
    const lines = [`## Impact of changing ${heading(node)}`];
    if (depth.note) lines.push(`(${depth.note})`);
    if (!impact) return [...lines, 'This symbol is no longer in the graph.'].join('\n');
    const tests = q.testFilePaths();
    const code = impact.files.filter((f) => !tests.has(f));
    const testFiles = impact.files.filter((f) => tests.has(f));
    lines.push(`Files to touch (${code.length}):`, ...code.map((f) => `- ${f}`));
    if (testFiles.length > 0) lines.push(`Tests that depend on it (${testFiles.length}):`, ...testFiles.map((f) => `- ${f}`));
    if (impact.byDepth.length === 0) lines.push(`Nothing depends on it within depth ${depth.depth}.`);
    for (const level of impact.byDepth) {
      lines.push(`### Depth ${level.depth} (${level.nodes.length})`);
      lines.push(...level.nodes.map((n) => (n.kind === 'file' ? `- ${n.filePath} (file)` : `- ${n.qualifiedName} (${n.kind}) — ${location(n)}`)));
    }
    if (impact.truncated) lines.push('Incomplete: the impact was capped; more dependents exist beyond this list.');
    return lines.join('\n');
  }),
);

interface SearchArgs {
  query: string;
  kinds?: NodeKind[];
  limit: number;
}

const KIND_SET = new Set<string>(NODE_KINDS);

const searchTool: Tool<SearchArgs> = {
  parse(args) {
    const query = nonEmptyString(args['query']);
    const limit = optionalNumber(args['limit']);
    const kindsRaw = args['kinds'];
    if (query === undefined || !limit.ok) return bad;
    let kinds: NodeKind[] | undefined;
    if (kindsRaw !== undefined && kindsRaw !== null) {
      if (!Array.isArray(kindsRaw) || !kindsRaw.every((k) => typeof k === 'string' && KIND_SET.has(k))) return bad;
      if (kindsRaw.length > 0) kinds = kindsRaw as NodeKind[];
    }
    const n = Math.floor(limit.value ?? DEFAULT_SEARCH_LIMIT);
    const value: SearchArgs = { query, limit: Math.min(MAX_SEARCH_LIMIT, Math.max(1, n)) };
    if (kinds) value.kinds = kinds;
    return good(value);
  },
  run(q, { query, kinds, limit }) {
    const hits = searchSymbols(q, query, { limit, ...(kinds && { kinds }) });
    if (hits.length === 0) {
      return {
        text: `No symbols match \`${query}\`${kinds ? ` (kinds: ${kinds.join(', ')})` : ''}. Try a shorter part of the name, or graph_explore with exact names.`,
      };
    }
    const lines = [`## Search \`${query}\` — ${plural(hits.length, 'result')}`];
    for (const { node } of hits) {
      lines.push(`- ${heading(node)}${node.signature ? ` — \`${node.signature}\`` : ''}`);
    }
    return { text: lines.join('\n') };
  },
};

const nodeTool: Tool<string> = {
  parse(args) {
    const symbol = nonEmptyString(args['symbol']);
    return symbol === undefined ? bad : good(symbol);
  },
  run(q, symbol, { ctx }) {
    const detail = getNodeDetail(q, ctx.project, symbol);
    if (detail.found) return { text: detail.markdown };
    return { text: looksLikePath(symbol) ? notFoundText(q, symbol) : `${detail.markdown}\n${similarLine(q, symbol)}` };
  },
};

const exploreTool: Tool<string> = {
  parse(args) {
    const query = nonEmptyString(args['query']);
    return query === undefined ? bad : good(query);
  },
  run(q, query, { ctx }) {
    const result = exploreSymbols(q, ctx.project, query);
    const budget = getExploreOutputBudget(q.counts().files).maxChars;
    return { text: result.markdown, maxChars: Math.max(MAX_OUTPUT_CHARS, budget) };
  },
};

interface FilesArgs {
  prefix: string;
  pattern?: string;
}

const filesTool: Tool<FilesArgs> = {
  parse(args, ctx) {
    const p = optionalString(args['path']);
    const pattern = optionalString(args['pattern']);
    if (!p.ok || !pattern.ok) return bad;
    const prefix = p.value === undefined || p.value.trim() === '' ? '' : projectRelative(ctx.project, p.value.trim());
    const pat = pattern.value?.trim();
    return good(pat ? { prefix, pattern: pat } : { prefix });
  },
  run(q, { prefix, pattern }) {
    const re = pattern === undefined ? undefined : globToRegExp(pattern);
    const byName = pattern !== undefined && !pattern.includes('/');
    const rows = q.fileRecords().filter((r) => {
      if (prefix !== '' && r.path !== prefix && !r.path.startsWith(`${prefix}/`)) return false;
      if (!re) return true;
      return re.test(byName ? r.path.slice(r.path.lastIndexOf('/') + 1) : r.path);
    });
    const where = `${prefix !== '' ? ` under \`${prefix}\`` : ''}${pattern !== undefined ? ` matching \`${pattern}\`` : ''}`;
    if (rows.length === 0) {
      return { text: `No indexed files${where || ' in this project'}. Check the path with graph_files without arguments.` };
    }
    const shown = rows.slice(0, MAX_FILES_LISTED);
    const lines = [`## Indexed files${where} — ${plural(rows.length, 'file')}`];
    let dir: string | undefined;
    for (const r of shown) {
      const slash = r.path.lastIndexOf('/');
      const d = slash < 0 ? '' : r.path.slice(0, slash);
      if (d !== dir) {
        dir = d;
        lines.push(`### ${d === '' ? './' : `${d}/`}`);
      }
      const flags = `${r.isTest ? ', test' : ''}${r.generated ? ', generated' : ''}`;
      lines.push(`- ${r.path.slice(slash + 1)} (${r.language}, ${plural(q.fileSymbolCount(r.path), 'symbol')}${flags})`);
    }
    if (rows.length > shown.length) {
      lines.push(`… ${rows.length - shown.length} more files not shown — narrow with path or pattern`);
    }
    return { text: lines.join('\n') };
  },
};

const affectedTool: Tool<string[]> = {
  parse(args, ctx) {
    const files = args['files'];
    if (!Array.isArray(files) || files.length === 0) return bad;
    if (!files.every((f): f is string => typeof f === 'string' && f.trim() !== '')) return bad;
    return good(files.map((f) => projectRelative(ctx.project, f.trim()) || '.'));
  },
  run(q, files) {
    const r = getAffected(q, files);
    const list = (title: string, items: string[]): string[] =>
      items.length === 0 ? [`${title} (0): none`] : [`${title} (${items.length}):`, ...items.map((f) => `- ${f}`)];
    const lines = [
      `## Affected by changes to ${plural(files.length, 'file')}`,
      ...list('Files affected', r.files),
      ...list('Tests to run', r.tests),
    ];
    if (r.unknown.length > 0) {
      lines.push(
        `Not in the graph (${r.unknown.length}): ${r.unknown.join(', ')} — not indexed (unsupported language, ignored or not a source file), so their dependents are unknown.`,
      );
    }
    if (r.truncated) {
      lines.push(
        'Incomplete: the file list was capped, or the dependents of some changed files were not fully explored; more files may be affected.',
      );
    }
    return { text: lines.join('\n') };
  },
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: unknown }).code === 'EPERM';
  }
}

const statusTool: Tool<null> = {
  parse: () => good(null),
  run(q, _v, { ctx, notes }) {
    const doc = ctx.store.loadDoc(ctx.project);
    const counts = q.counts();
    const languages = Object.entries(q.languageCounts())
      .map(([lang, n]) => `${lang} ${n}`)
      .join(', ');
    const lock = readWriterLock(ctx.dataDir);
    const indexing = isFullIndexRunning(ctx.dataDir);
    const syncing = lock !== null && lock.owner === 'sync' && lock.pid !== process.pid && isProcessAlive(lock.pid);
    const yesNo = (b: boolean): string => (b ? 'yes' : 'no');
    const lines = [
      '## Code graph status',
      `Files: ${counts.files} · Nodes: ${counts.nodes} · Edges: ${counts.edges}`,
      `Languages: ${languages || 'none'}`,
      `Indexed at: ${doc ? new Date(doc.indexedAt).toISOString() : 'unknown'}`,
    ];
    if (doc?.builtAtCommit) lines.push(`Built at commit: ${doc.builtAtCommit.slice(0, 12)}`);
    lines.push(
      `Auto-update in Devia: ${doc?.autoUpdate === false ? 'off' : 'on'}`,
      `Index running: ${yesNo(indexing)}`,
      `Sync running in another process: ${yesNo(syncing)}`,
      `Full re-index required: ${yesNo(ctx.freshness.lastResult?.fullIndexRequired === true)}`,
      `Catching up with recent edits: ${yesNo(ctx.freshness.lastResult?.truncated === true)}`,
      `Last refresh: ${indexing ? 'skipped while the index runs' : notes.includes(NOTE_SYNC_FAILED) ? 'failed' : 'ok'}`,
    );
    if (counts.files === 0) lines.push('No supported source files were indexed; graph tools will find nothing here.');
    return { text: lines.join('\n') };
  },
};

function erase<T>(t: Tool<T>): Tool<unknown> {
  return { parse: (args, ctx) => t.parse(args, ctx), run: (q, v, env) => t.run(q, v as T, env) };
}

const TOOLS: Record<string, Tool<unknown>> = {
  graph_explore: erase(exploreTool),
  graph_search: erase(searchTool),
  graph_node: erase(nodeTool),
  graph_callers: erase(callTool('Callers')),
  graph_callees: erase(callTool('Callees')),
  graph_impact: erase(impactTool),
  graph_affected: erase(affectedTool),
  graph_files: erase(filesTool),
  graph_status: erase(statusTool),
};

// ── entry point ───────────────────────────────────────────────────────────

const ok = (text: string): GraphToolResult => ({ content: [{ type: 'text', text }] });
const failure = (text: string): GraphToolResult => ({ content: [{ type: 'text', text }], isError: true });

function withNotes(body: string, notes: string[], maxChars: number): string {
  const unique = [...new Set(notes)];
  if (unique.length === 0) return capOutput(body, maxChars);
  const tail = unique.map((n) => `⚠ ${n}`).join('\n');
  return `${capOutput(body, maxChars - tail.length - 1)}\n${tail}`;
}

function accessGuidance(ctx: GraphToolContext): string | undefined {
  if (ctx.store.loadDoc(ctx.project)?.agentAccess === false) return DISABLED_TEXT;
  if (!fs.existsSync(ctx.dbPath)) return isFullIndexRunning(ctx.dataDir) ? FIRST_INDEX_TEXT : NO_GRAPH_TEXT;
  return undefined;
}

/**
 * Never throws. Every recoverable condition (no graph, access off, unknown symbol, bad
 * arguments, stale graph) is a normal answer with guidance; `isError` is reserved for a path
 * outside the project and for genuine internal failures.
 */
export async function callGraphTool(ctx: GraphToolContext, name: string, rawArgs: unknown): Promise<GraphToolResult> {
  const tool = TOOLS[name];
  if (!tool) return ok(`Unknown tool \`${name}\`. Available: ${GRAPH_TOOLS.map((t) => t.name).join(', ')}.`);
  const args: Args = typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs) ? (rawArgs as Args) : {};
  try {
    const guidance = accessGuidance(ctx);
    if (guidance) return ok(guidance);
    const parsed = tool.parse(args, ctx);
    if (!parsed.ok) return ok(USAGE[name] ?? `Usage: ${name}`);
    const notes = await ensureFresh(ctx);
    if (!fs.existsSync(ctx.dbPath)) return ok(NO_GRAPH_TEXT);
    const db = openGraphDb(ctx.dbPath, { readonly: true });
    let out: { text: string; maxChars?: number };
    try {
      out = tool.run(new GraphQueries(db), parsed.value, { ctx, notes });
    } finally {
      db.close();
    }
    return ok(withNotes(out.text, notes, out.maxChars ?? MAX_OUTPUT_CHARS));
  } catch (e) {
    if (e instanceof PathRefusedError || (e as { code?: unknown }).code === 'PATH_REFUSED') {
      return failure(`PATH_REFUSED: ${(e as Error).message}. Only paths inside the project root are accepted.`);
    }
    const message = e instanceof Error ? e.message : String(e);
    ctx.log(`[devia-code-graph] ${name} failed: ${e instanceof Error ? e.stack ?? message : message}`);
    return failure(
      `Internal error in ${name}: ${message}. Retry once; if it fails again, answer this question without the graph.`,
    );
  }
}
