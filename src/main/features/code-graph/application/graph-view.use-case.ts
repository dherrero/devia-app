import * as fs from 'node:fs';
import {
  GRAPH_EDGE_LIMIT,
  GRAPH_EXPAND_LIMIT,
  GRAPH_PAGE_LIMIT,
  type EdgeKind,
  type GraphDirDetail,
  type GraphExpandOptions,
  type GraphFileDetail,
  type GraphFileRef,
  type GraphNode,
  type GraphNodeDetail,
  type GraphOverviewNode,
  type GraphOverviewOptions,
  type GraphSearchResult,
  type GraphSymbolDetail,
  type GraphViewEdge,
  type GraphViewPage,
} from '../../../../shared/domain/code-graph';
import { openGraphDb, type GraphDb } from '../engine/db/connection';
import { GraphQueries, type ViewChildRow, type ViewEdgeQuery } from '../engine/db/queries';
import { readCommunities, readHubs, type Hub } from '../engine/graph/communities';
import { getCallees, getCallers, getImpact } from '../engine/graph/traversal';
import { searchSymbols } from '../engine/search/search';
import type { CodeGraphStore } from '../infrastructure/code-graph-store';

export interface GraphViewUseCaseDeps {
  store: CodeGraphStore;
  openDb?: typeof openGraphDb;
}

const AGGREGATE_KINDS: EdgeKind[] = ['imports', 'calls', 'instantiates', 'extends', 'implements', 'references'];
const DIR = 'dir:';
export const VIEW_CACHE_PROJECTS = 5;
const HUB_FLAGS = 20;
const DETAIL_NODES = 50;
const DETAIL_IMPACT_FILES = 50;
const DETAIL_FILE_REFS = 20;
const DETAIL_TOP_HUBS = 5;
const SEARCH_SYMBOLS = 40;
const SEARCH_FILES = 10;
const SEARCH_MAX = 50;
const MAX_NESTING = 64;
const READ_CACHE_KIB = -65536;
const READ_MMAP_BYTES = 256 * 1024 * 1024;

interface GraphVersion {
  /** graph.db alone: changes when a full index swaps the file in (or a checkpoint lands). */
  file: string;
  /** graph.db plus its WAL: changes on every write, an incremental sync included. */
  full: string;
}

interface CacheEntry {
  file: string;
  full: string;
  /** Hints persisted by the last full index; a sync leaves them as they are. */
  communities?: Map<string, number>;
  hubs?: Hub[];
  hubFlags?: Set<string>;
  overviewEdges?: GraphViewEdge[];
}

interface Ctx {
  q: GraphQueries;
  entry: CacheEntry;
  communities(): Map<string, number>;
  hubs(): Hub[];
  hubFlags(): Set<string>;
  /** Generated file paths, read once per request (a sync can change them). */
  generatedFiles(): Set<string>;
}

const emptyPage = (): GraphViewPage => ({ nodes: [], edges: [], total: 0, hasMore: false });
const dirId = (p: string): string => `${DIR}${p}`;
const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function parseDirId(id: string): string | undefined {
  if (!id.startsWith(DIR)) return undefined;
  const p = id.slice(DIR.length);
  return p !== '' && p.split('/').every((s) => s !== '') ? p : undefined;
}

/** Directories above a path, outermost first: 'a/b/c.ts' → ['a', 'a/b']. */
function parentDirs(p: string): string[] {
  const out: string[] = [];
  for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) out.push(p.slice(0, i));
  return out;
}

// The full version includes the WAL: an incremental sync writes there without touching graph.db.
function graphVersion(file: string): GraphVersion | undefined {
  let main: fs.Stats;
  try {
    main = fs.statSync(file);
  } catch {
    return undefined;
  }
  let wal = '';
  try {
    const w = fs.statSync(`${file}-wal`);
    if (w.size > 0) wal = `${w.mtimeMs}:${w.size}`;
  } catch {
    // no WAL
  }
  const base = `${main.ino}:${main.mtimeMs}:${main.size}`;
  return { file: base, full: `${base}:${wal}` };
}

/** Keeps the heaviest GRAPH_EDGE_LIMIT edges and flags the page when some were cut. */
function withEdges(page: GraphViewPage, edges: GraphViewEdge[]): GraphViewPage {
  if (edges.length <= GRAPH_EDGE_LIMIT) return { ...page, edges };
  const kept = [...edges]
    .sort((a, b) => b.weight - a.weight || compare(a.source, b.source) || compare(a.target, b.target))
    .slice(0, GRAPH_EDGE_LIMIT);
  return { ...page, edges: kept, edgesTruncated: true };
}

function fileScore(filePath: string, text: string): number {
  const t = text.toLowerCase();
  const base = basename(filePath).toLowerCase();
  if (base === t) return 100;
  const dot = base.lastIndexOf('.');
  if (dot > 0 && base.slice(0, dot) === t) return 90;
  if (base.startsWith(t)) return 60;
  return 30;
}

/**
 * Read model of the graph screen: a lazily expanded hierarchy (dirs → files →
 * symbols) with aggregated edges. Every call opens the graph read-only and
 * closes it before returning; only per-graph-version derivatives are cached.
 */
export class GraphViewUseCase {
  private readonly store: CodeGraphStore;
  private readonly openDb: typeof openGraphDb;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(deps: GraphViewUseCaseDeps) {
    this.store = deps.store;
    this.openDb = deps.openDb ?? openGraphDb;
  }

  /** Root entries; a page past the first carries its edges back to the earlier pages too. */
  overview(projectAbs: string, opts: GraphOverviewOptions = {}): GraphViewPage {
    return this.withGraph(projectAbs, emptyPage, (ctx) => {
      const offset = opts.offset ?? 0;
      const rows = ctx.q.viewDirChildren('');
      const page = this.dirPage(ctx, rows, undefined, offset);
      if (page.nodes.length === 0) return page;
      const fresh = new Set(page.nodes.map((n) => n.id));
      const shown = new Set(rows.slice(0, offset + page.nodes.length).map((r) => (r.isDir ? dirId(r.path) : r.fileId)));
      ctx.entry.overviewEdges ??= this.topLevelEdges(ctx.q, rows);
      return withEdges(
        page,
        ctx.entry.overviewEdges.filter(
          (e) => (fresh.has(e.source) || fresh.has(e.target)) && shown.has(e.source) && shown.has(e.target),
        ),
      );
    });
  }

  expand(projectAbs: string, nodeId: string, opts: GraphExpandOptions): GraphViewPage {
    return this.withGraph(projectAbs, emptyPage, (ctx) => {
      const offset = opts.offset ?? 0;
      const visible = opts.visibleIds.slice(0, GRAPH_PAGE_LIMIT);
      if (nodeId.startsWith(DIR)) {
        const dir = parseDirId(nodeId);
        if (dir === undefined) return emptyPage();
        const rows = ctx.q.viewDirChildren(dir);
        if (rows.length === 0) return emptyPage();
        const page = this.dirPage(ctx, rows, dir, offset);
        const keys = new Set(page.nodes.map((n) => n.path));
        const whole = page.nodes.length === rows.length;
        const childKey = (fp: string): string => {
          const i = fp.indexOf('/', dir.length + 1);
          return i < 0 ? fp : fp.slice(0, i);
        };
        return withEdges(
          page,
          this.edgesFor(ctx, page.nodes, visible, {
            scope: { dir },
            inScope: whole ? () => true : (fp) => keys.has(childKey(fp)),
            blocked: [nodeId, ...parentDirs(dir).map(dirId)],
          }),
        );
      }
      const node = ctx.q.nodeById(nodeId);
      if (!node) return emptyPage();
      const total = ctx.q.containsChildCounts([node.id]).get(node.id) ?? 0;
      if (total === 0) return emptyPage();
      const nodes = this.symbolNodes(ctx, ctx.q.containsChildren(node.id, offset, GRAPH_EXPAND_LIMIT), node.id);
      const edges = this.edgesFor(ctx, nodes, visible, {
        scope: { file: node.filePath },
        inScope: () => true,
        blocked: [node.id, ...this.ancestorsOf(ctx.q, node)],
      });
      return withEdges({ nodes, edges: [], total, hasMore: offset + nodes.length < total }, edges);
    });
  }

  nodeDetail(projectAbs: string, nodeId: string): GraphNodeDetail | undefined {
    return this.withGraph(projectAbs, () => undefined, (ctx): GraphNodeDetail | undefined => {
      if (nodeId.startsWith(DIR)) {
        const dir = parseDirId(nodeId);
        return dir === undefined ? undefined : this.dirDetail(ctx, dir);
      }
      const node = ctx.q.nodeById(nodeId);
      if (!node) return undefined;
      return node.kind === 'file' ? this.fileDetail(ctx, node) : this.symbolDetail(ctx, node);
    });
  }

  search(projectAbs: string, query: string): GraphSearchResult[] {
    const text = query.trim();
    if (text === '') return [];
    return this.withGraph(projectAbs, () => [], (ctx) => {
      const seen = new Set<string>();
      const hits: { node: GraphNode; score: number }[] = [];
      for (const r of searchSymbols(ctx.q, text, { limit: SEARCH_SYMBOLS })) {
        if (seen.has(r.node.id)) continue;
        seen.add(r.node.id);
        hits.push(r);
      }
      for (const f of ctx.q.searchFiles(text, SEARCH_FILES)) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        hits.push({ node: f, score: fileScore(f.filePath, text) });
      }
      hits.sort(
        (a, b) => b.score - a.score || compare(a.node.filePath, b.node.filePath) || compare(a.node.id, b.node.id),
      );
      const top = hits.slice(0, SEARCH_MAX);
      const files = [...new Set(top.map((h) => h.node.filePath))];
      const parents = ctx.q.containsParents(files);
      const fileIds = ctx.q.fileNodeIds(files);
      const counts = ctx.q.containsChildCounts(top.map((h) => h.node.id));
      return top.map((h) => {
        const ancestors = this.chainOf(h.node, parents, fileIds);
        return {
          node: this.toOverview(ctx, h.node, counts.get(h.node.id) ?? 0, ancestors[ancestors.length - 1]),
          ancestors,
          score: h.score,
        };
      });
    });
  }

  private withGraph<T>(projectAbs: string, empty: () => T, fn: (ctx: Ctx) => T): T {
    const file = this.store.dbPath(projectAbs);
    const version = graphVersion(file);
    if (version === undefined) return empty();
    let db: GraphDb;
    try {
      db = this.openDb(file, { readonly: true });
    } catch (err) {
      // Removed (reset, swap) between the stat and the open: the same as no graph.
      if (!fs.existsSync(file)) return empty();
      throw err;
    }
    try {
      // Each request starts with a cold connection; the default 2 MB page cache thrashes on
      // the random id lookups of an aggregation over a large graph (measured ~25% slower).
      db.exec(`PRAGMA cache_size = ${READ_CACHE_KIB}`);
      // Memory-mapped reads skip a copy per page: ~18% faster on the 150k-edge aggregation.
      // Safe here: the live graph file is only ever grown or replaced, never truncated.
      db.exec(`PRAGMA mmap_size = ${READ_MMAP_BYTES}`);
      // The temp map and GROUP BY trees of the aggregations stay off disk (~10% on the overview scan).
      db.exec('PRAGMA temp_store = MEMORY');
      const q = new GraphQueries(db);
      const entry = this.entryFor(projectAbs, version);
      const hubs = (): Hub[] => (entry.hubs ??= readHubs(q));
      let generated: Set<string> | undefined;
      return fn({
        q,
        entry,
        communities: () => (entry.communities ??= readCommunities(q)),
        hubs,
        hubFlags: () => (entry.hubFlags ??= new Set(hubs().slice(0, HUB_FLAGS).map((h) => h.nodeId))),
        generatedFiles: () => (generated ??= q.generatedFilePaths()),
      });
    } finally {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
  }

  private entryFor(projectAbs: string, version: GraphVersion): CacheEntry {
    const current = this.cache.get(projectAbs);
    this.cache.delete(projectAbs);
    const entry: CacheEntry = current?.file === version.file ? current : { file: version.file, full: version.full };
    if (entry.full !== version.full) {
      entry.full = version.full;
      delete entry.overviewEdges;
    }
    this.cache.set(projectAbs, entry);
    for (const key of this.cache.keys()) {
      if (this.cache.size <= VIEW_CACHE_PROJECTS) break;
      this.cache.delete(key);
    }
    return entry;
  }

  private topLevelEdges(q: GraphQueries, rows: ViewChildRow[]): GraphViewEdge[] {
    const fileIds = new Map(rows.flatMap((r) => (r.fileId === undefined ? [] : [[r.path, r.fileId] as const])));
    const key = (k: string): string | undefined => (k.endsWith('/') ? dirId(k.slice(0, -1)) : fileIds.get(k));
    return q.viewTopLevelEdges(AGGREGATE_KINDS).flatMap((r) => {
      const source = key(r.source);
      const target = key(r.target);
      return source !== undefined && target !== undefined && source !== target
        ? [{ source, target, kind: 'aggregate' as const, weight: r.weight }]
        : [];
    });
  }

  private dirPage(ctx: Ctx, rows: ViewChildRow[], parent: string | undefined, offset: number): GraphViewPage {
    const slice = rows.slice(offset, offset + GRAPH_EXPAND_LIMIT);
    const communities = ctx.communities();
    const dominant = dominantCommunities(communities, parent, slice.filter((r) => r.isDir).map((r) => r.path));
    const nodes = slice.map((r) => {
      const n: GraphOverviewNode = r.isDir
        ? {
            id: dirId(r.path),
            kind: 'dir',
            label: basename(r.path),
            childCount: r.childCount,
            path: r.path,
            fileCount: r.fileCount,
            symbolCount: r.symbolCount,
          }
        : {
            id: r.fileId as string,
            kind: 'file',
            label: basename(r.path),
            childCount: r.childCount,
            path: r.path,
            symbolCount: r.symbolCount,
          };
      if (parent !== undefined) n.parentId = dirId(parent);
      if (r.language !== undefined) n.language = r.language;
      if (r.isTest === true) n.isTest = true;
      if (r.generated === true) n.generated = true;
      const community = r.isDir ? dominant.get(r.path) : communities.get(r.path);
      if (community !== undefined) n.community = community;
      return n;
    });
    return { nodes, edges: [], total: rows.length, hasMore: offset + slice.length < rows.length };
  }

  private symbolNodes(ctx: Ctx, nodes: GraphNode[], parentId: string): GraphOverviewNode[] {
    const counts = ctx.q.containsChildCounts(nodes.map((n) => n.id));
    return nodes.map((n) => this.toOverview(ctx, n, counts.get(n.id) ?? 0, parentId));
  }

  private toOverview(ctx: Ctx, n: GraphNode, childCount: number, parentId: string | undefined): GraphOverviewNode {
    const isFile = n.kind === 'file';
    const o: GraphOverviewNode = {
      id: n.id,
      kind: n.kind,
      label: isFile ? basename(n.filePath) : n.name,
      childCount,
      path: n.filePath,
      language: n.language,
    };
    if (!isFile) {
      o.exported = n.isExported;
      o.line = n.startLine;
    }
    if (parentId !== undefined) o.parentId = parentId;
    if (n.isTest === true) o.isTest = true;
    if (ctx.generatedFiles().has(n.filePath)) o.generated = true;
    const community = ctx.communities().get(n.filePath);
    if (community !== undefined) o.community = community;
    if (!isFile && ctx.hubFlags().has(n.id)) o.hub = true;
    return o;
  }

  /**
   * Aggregated edges of freshly expanded children: each real endpoint is folded onto
   * its nearest visible node (itself, an enclosing symbol, its file, the deepest
   * visible directory); pairs not touching a new child, or touching the expanded
   * node or one of its ancestors, are left out.
   */
  private edgesFor(
    ctx: Ctx,
    fresh: GraphOverviewNode[],
    visibleIds: string[],
    opts: { scope: ViewEdgeQuery['scope']; inScope: ViewEdgeQuery['inScope']; blocked: string[] },
  ): GraphViewEdge[] {
    if (fresh.length === 0) return [];
    const ids = new Set<string>();
    const dirs = new Set<string>();
    const files = new Map<string, string>();
    const symbolFiles = new Set<string>();
    const real: string[] = [];
    for (const id of visibleIds) {
      const d = parseDirId(id);
      if (d !== undefined) dirs.add(d);
      else if (!id.startsWith(DIR)) real.push(id);
    }
    const located = [
      ...ctx.q.nodeLocations(real),
      ...fresh.filter((n) => n.kind !== 'dir').map((n) => ({ id: n.id, kind: n.kind, filePath: n.path })),
    ];
    for (const loc of located) {
      ids.add(loc.id);
      if (loc.kind === 'file') files.set(loc.filePath, loc.id);
      else symbolFiles.add(loc.filePath);
    }
    for (const n of fresh) if (n.kind === 'dir') dirs.add(n.path);
    const parents = ctx.q.containsParents([...symbolFiles]);
    const byFile = new Map<string, string | null>();
    const rep = (filePath: string, id: string): string | null => {
      if (ids.has(id)) return id;
      if (symbolFiles.has(filePath)) {
        let p = parents.get(id);
        for (let depth = 0; p !== undefined && depth < MAX_NESTING; depth++) {
          if (ids.has(p)) return p;
          p = parents.get(p);
        }
      }
      const known = byFile.get(filePath);
      if (known !== undefined) return known;
      let r = files.get(filePath) ?? null;
      for (let i = filePath.lastIndexOf('/'); r === null && i > 0; i = filePath.lastIndexOf('/', i - 1)) {
        const d = filePath.slice(0, i);
        if (dirs.has(d)) r = dirId(d);
      }
      byFile.set(filePath, r);
      return r;
    };
    const freshIds = new Set(fresh.map((n) => n.id));
    const blocked = new Set(opts.blocked);
    return ctx.q
      .viewAggregateEdges({ scope: opts.scope, kinds: AGGREGATE_KINDS, inScope: opts.inScope, rep })
      .filter(
        (r) =>
          (freshIds.has(r.source) || freshIds.has(r.target)) && !blocked.has(r.source) && !blocked.has(r.target),
      )
      .map((r) => ({ source: r.source, target: r.target, kind: 'aggregate' as const, weight: r.weight }));
  }

  /** Ids to expand, outermost first, to reveal `node`: its dirs, its file, its enclosing symbols. */
  private ancestorsOf(q: GraphQueries, node: GraphNode): string[] {
    return this.chainOf(node, q.containsParents([node.filePath]), q.fileNodeIds([node.filePath]));
  }

  private chainOf(node: GraphNode, parents: Map<string, string>, fileIds: Map<string, string>): string[] {
    const dirs = parentDirs(node.filePath).map(dirId);
    if (node.kind === 'file') return dirs;
    const fileId = fileIds.get(node.filePath);
    const containers: string[] = [];
    let p = parents.get(node.id);
    for (let depth = 0; p !== undefined && p !== fileId && depth < MAX_NESTING; depth++) {
      containers.push(p);
      p = parents.get(p);
    }
    return [...dirs, ...(fileId === undefined ? [] : [fileId]), ...containers.reverse()];
  }

  private dirDetail(ctx: Ctx, dir: string): GraphDirDetail | undefined {
    const summary = ctx.q.dirSummary(dir);
    if (summary.fileCount === 0) return undefined;
    const prefix = `${dir}/`;
    const counts = new Map<number, number>();
    for (const [file, c] of ctx.communities()) if (file.startsWith(prefix)) counts.set(c, (counts.get(c) ?? 0) + 1);
    return {
      kind: 'dir',
      id: dirId(dir),
      path: dir,
      ancestors: parentDirs(dir).map(dirId),
      fileCount: summary.fileCount,
      symbolCount: summary.symbolCount,
      languages: summary.languages,
      topHubs: this.topHubsUnder(ctx, prefix),
      communities: [...counts.entries()]
        .map(([id, files]) => ({ id, files }))
        .sort((a, b) => b.files - a.files || a.id - b.id),
    };
  }

  /** The persisted ranking filtered by path; nodes gone since the last full index are skipped. */
  private topHubsUnder(ctx: Ctx, prefix: string): GraphNode[] {
    const ranked = ctx.hubs();
    const byId = new Map(ctx.q.nodesByIds(ranked.map((h) => h.nodeId)).map((n) => [n.id, n]));
    const out: GraphNode[] = [];
    for (const h of ranked) {
      const n = byId.get(h.nodeId);
      if (n?.filePath.startsWith(prefix) !== true) continue;
      out.push(n);
      if (out.length === DETAIL_TOP_HUBS) break;
    }
    return out;
  }

  private fileDetail(ctx: Ctx, node: GraphNode): GraphFileDetail {
    const importedBy = ctx.q.importingFilePaths(node.filePath);
    const imports = ctx.q.importedFilePaths(node.filePath);
    const shown = [...importedBy.slice(0, DETAIL_FILE_REFS), ...imports.slice(0, DETAIL_FILE_REFS)];
    const ids = ctx.q.fileNodeIds(shown);
    const refs = (paths: string[]): GraphFileRef[] =>
      paths.slice(0, DETAIL_FILE_REFS).flatMap((p) => {
        const id = ids.get(p);
        return id === undefined ? [] : [{ id, path: p }];
      });
    const out: GraphFileDetail = {
      kind: 'file',
      node,
      path: node.filePath,
      language: node.language,
      ancestors: parentDirs(node.filePath).map(dirId),
      symbolCount: ctx.q.fileSymbolCount(node.filePath),
      importedBy: refs(importedBy),
      importedByCount: importedBy.length,
      imports: refs(imports),
      importsCount: imports.length,
    };
    const community = ctx.communities().get(node.filePath);
    if (community !== undefined) out.community = community;
    if (node.isTest === true) out.isTest = true;
    return out;
  }

  private symbolDetail(ctx: Ctx, node: GraphNode): GraphSymbolDetail {
    const impact = getImpact(ctx.q, node.id);
    const files = impact?.files ?? [];
    const listed = files.slice(0, DETAIL_IMPACT_FILES);
    const fileIds = ctx.q.fileNodeIds(listed);
    const out: GraphSymbolDetail = {
      kind: 'symbol',
      node,
      ancestors: this.ancestorsOf(ctx.q, node),
      callers: getCallers(ctx.q, node.id, { limit: DETAIL_NODES }).map((h) => h.node),
      callees: getCallees(ctx.q, node.id, { limit: DETAIL_NODES }).map((h) => h.node),
      impact: {
        files: listed,
        refs: listed.flatMap((p) => {
          const id = fileIds.get(p);
          return id === undefined ? [] : [{ id, path: p }];
        }),
        count: files.length,
        truncated: (impact?.truncated ?? false) || files.length > DETAIL_IMPACT_FILES,
      },
    };
    const community = ctx.communities().get(node.filePath);
    if (community !== undefined) out.community = community;
    if (ctx.hubFlags().has(node.id)) out.hub = true;
    if (node.signature !== undefined) out.signature = node.signature;
    if (node.docstring !== undefined) out.docstring = node.docstring;
    return out;
  }
}

/** Most frequent community of the files under each dir (ties → lowest id). */
function dominantCommunities(
  communities: Map<string, number>,
  parent: string | undefined,
  dirs: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (dirs.length === 0) return out;
  const wanted = new Set(dirs);
  const start = parent === undefined ? 0 : parent.length + 1;
  const tallies = new Map<string, Map<number, number>>();
  for (const [file, c] of communities) {
    const slash = file.indexOf('/', start);
    if (slash < 0) continue;
    const dir = file.slice(0, slash);
    if (!wanted.has(dir)) continue;
    const t = tallies.get(dir) ?? new Map<number, number>();
    t.set(c, (t.get(c) ?? 0) + 1);
    tallies.set(dir, t);
  }
  for (const [dir, t] of tallies) {
    let best: [number, number] | undefined;
    for (const [c, n] of t) if (!best || n > best[1] || (n === best[1] && c < best[0])) best = [c, n];
    if (best) out.set(dir, best[0]);
  }
  return out;
}
