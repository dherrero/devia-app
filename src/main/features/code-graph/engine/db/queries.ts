import type { StatementSync } from 'node:sqlite';
import type {
  CodeGraphLanguage,
  EdgeKind,
  GraphEdge,
  GraphNode,
  NodeKind,
  RefMetadata,
} from '../../../../../shared/domain/code-graph';
import type { GraphDb } from './connection';

export interface FileRow {
  path: string;
  contentHash: string;
  language: CodeGraphLanguage;
  size: number;
  modifiedAt: number;
  indexedAt: number;
  nodeCount: number;
  generated: boolean;
  isTest: boolean;
  errors?: string[];
}

export interface UnresolvedRef {
  id?: number;
  fromNodeId: string;
  referenceName: string;
  referenceKind: EdgeKind;
  line: number;
  col: number;
  filePath: string;
  language: CodeGraphLanguage;
  status: RefStatus;
  nameTail: string;
  metadata?: RefMetadata;
}

/**
 * `pending` waits for resolution, `failed` waits for a file that could satisfy it. `bound` is a
 * resolved import that binds a name: kept so a later partial resolution can rebuild that file's
 * import bindings without re-extracting it (receiver types are looked up in the file that
 * declares them, which a sync need not touch).
 */
export type RefStatus = 'pending' | 'failed' | 'bound';

/** What a resolution read in another file: that file, or a name it looked up (S-44 T-515). */
export type ResolutionDepKind = 'file' | 'name';

export type NodeSummary = Pick<
  GraphNode,
  | 'id'
  | 'kind'
  | 'name'
  | 'qualifiedName'
  | 'filePath'
  | 'language'
  | 'startLine'
  | 'endLine'
  | 'isExported'
  | 'metadata'
>;

interface SummaryRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  is_exported: number;
  metadata: string | null;
}

// Keeps IN (...) lists well under SQLite's bound-parameter limit.
const IN_CHUNK = 500;

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  docstring: string | null;
  signature: string | null;
  is_exported: number;
  is_test: number;
  visibility: string | null;
  is_async: number;
  is_static: number;
  is_abstract: number;
  decorators: string | null;
  metadata: string | null;
}

interface EdgeRow {
  source: string;
  target: string;
  kind: string;
  line: number | null;
  provenance: string | null;
}

interface UnresolvedRow {
  id: number;
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  line: number;
  col: number;
  file_path: string;
  language: string;
  status: string;
  name_tail: string;
  metadata: string | null;
}

export interface SearchFilter {
  kinds?: NodeKind[];
  language?: CodeGraphLanguage;
  includeTests?: boolean;
  includeGenerated?: boolean;
}

export interface SearchRow {
  node: GraphNode;
  fileIsTest: boolean;
  fileGenerated: boolean;
  bm25?: number;
}

interface SearchRowRaw extends NodeRow {
  file_is_test: number | null;
  file_generated: number | null;
  bm25_score?: number;
}

// Must mirror the column order of nodes_fts in schema.sql (checked by a test).
export const FTS_COLUMNS = [
  'id',
  'name',
  'qualified_name',
  'docstring',
  'signature',
] as const;

export const FTS_BM25_WEIGHTS: Record<(typeof FTS_COLUMNS)[number], number> = {
  id: 0,
  name: 10,
  qualified_name: 4,
  docstring: 1,
  signature: 1,
};

const BM25_ARGS = FTS_COLUMNS.map((c) => FTS_BM25_WEIGHTS[c]).join(', ');

export type SubstringScope = 'name' | 'text';

const SEARCH_SELECT =
  'SELECT n.*, f.is_test AS file_is_test, f.generated AS file_generated';
const SEARCH_JOIN = 'LEFT JOIN files f ON f.path = n.file_path';

function searchFilterSql(filter: SearchFilter): {
  sql: string;
  params: (string | number)[];
} {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.kinds) {
    if (filter.kinds.length === 0) clauses.push('0');
    else {
      clauses.push(`n.kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }
  }
  if (filter.language) {
    clauses.push('n.language = ?');
    params.push(filter.language);
  }
  if (filter.includeTests === false)
    clauses.push('n.is_test = 0 AND COALESCE(f.is_test, 0) = 0');
  if (!filter.includeGenerated) clauses.push('COALESCE(f.generated, 0) = 0');
  return {
    sql: clauses.map((c) => ` AND ${c}`).join(''),
    params,
  };
}

function toSearchRow(r: SearchRowRaw): SearchRow {
  const row: SearchRow = {
    node: toNode(r),
    fileIsTest: r.file_is_test === 1,
    fileGenerated: r.file_generated === 1,
  };
  if (r.bm25_score !== undefined) row.bm25 = r.bm25_score;
  return row;
}

export interface ViewChildRow {
  /** Root-relative path of the child directory or file. */
  path: string;
  isDir: boolean;
  fileCount: number;
  symbolCount: number;
  /** Direct children: subdirs + files of a dir, `contains` children of a file. */
  childCount: number;
  fileId?: string;
  language?: CodeGraphLanguage;
  isTest?: boolean;
  /** A generated file, or a directory whose files are all generated. */
  generated?: boolean;
}

export interface ViewEdgeRow {
  source: string;
  target: string;
  weight: number;
}

export interface ViewEdgeQuery {
  /** Nodes whose edges are read: a directory subtree or a single file. */
  scope: { dir: string } | { file: string };
  kinds: EdgeKind[];
  /** Narrows the scope (e.g. to one page of a directory); called with file paths inside it. */
  inScope: (filePath: string) => boolean;
  /** Key an endpoint is folded into; `null` drops the edge. */
  rep: (filePath: string, id: string) => string | null;
}

export interface DirSummary {
  fileCount: number;
  symbolCount: number;
  languages: Partial<Record<CodeGraphLanguage, number>>;
}

const VIEW_REP_FN = 'cg_view_rep';
const VIEW_IN_FN = 'cg_view_in';
const VIEW_TOP_KEYS = 'temp.cg_view_top_keys';
const VIEW_TOP_NODES = 'temp.cg_view_top_nodes';

/** `[lo, hi)` bounds of every path under `dir/` ('0' is the code point after '/'). */
function dirRange(dir: string): [string, string] {
  return [`${dir}/`, `${dir}0`];
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function toNode(r: NodeRow): GraphNode {
  const n: GraphNode = {
    id: r.id,
    kind: r.kind as NodeKind,
    name: r.name,
    qualifiedName: r.qualified_name,
    filePath: r.file_path,
    language: r.language as CodeGraphLanguage,
    startLine: r.start_line,
    endLine: r.end_line,
    isExported: r.is_exported === 1,
  };
  if (r.signature !== null) n.signature = r.signature;
  if (r.docstring !== null) n.docstring = r.docstring;
  if (r.is_test === 1) n.isTest = true;
  if (r.visibility !== null)
    n.visibility = r.visibility as NonNullable<GraphNode['visibility']>;
  if (r.is_async === 1) n.isAsync = true;
  if (r.is_static === 1) n.isStatic = true;
  if (r.is_abstract === 1) n.isAbstract = true;
  if (r.decorators !== null)
    n.decorators = JSON.parse(r.decorators) as string[];
  if (r.metadata !== null) n.metadata = JSON.parse(r.metadata) as RefMetadata;
  return n;
}

function toEdge(r: EdgeRow): GraphEdge {
  const e: GraphEdge = {
    source: r.source,
    target: r.target,
    kind: r.kind as EdgeKind,
  };
  if (r.line !== null) e.line = r.line;
  if (r.provenance === 'static' || r.provenance === 'heuristic')
    e.provenance = r.provenance;
  return e;
}

function toUnresolved(r: UnresolvedRow): UnresolvedRef {
  const u: UnresolvedRef = {
    id: r.id,
    fromNodeId: r.from_node_id,
    referenceName: r.reference_name,
    referenceKind: r.reference_kind as EdgeKind,
    line: r.line,
    col: r.col,
    filePath: r.file_path,
    language: r.language as CodeGraphLanguage,
    status: r.status as RefStatus,
    nameTail: r.name_tail,
  };
  if (r.metadata !== null) u.metadata = JSON.parse(r.metadata) as RefMetadata;
  return u;
}

export class GraphQueries {
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(private readonly db: GraphDb) {}

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  upsertFile(f: FileRow): void {
    this.stmt(
      `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors, generated, is_test)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         content_hash = excluded.content_hash, language = excluded.language, size = excluded.size,
         modified_at = excluded.modified_at, indexed_at = excluded.indexed_at, node_count = excluded.node_count,
         errors = excluded.errors, generated = excluded.generated, is_test = excluded.is_test`,
    ).run(
      f.path,
      f.contentHash,
      f.language,
      f.size,
      f.modifiedAt,
      f.indexedAt,
      f.nodeCount,
      f.errors ? JSON.stringify(f.errors) : null,
      f.generated ? 1 : 0,
      f.isTest ? 1 : 0,
    );
  }

  deleteFile(path: string): void {
    this.transaction(() => {
      this.stmt('DELETE FROM nodes WHERE file_path = ?').run(path);
      this.stmt('DELETE FROM files WHERE path = ?').run(path);
      this.stmt('DELETE FROM resolution_deps WHERE file_path = ?').run(path);
    });
  }

  insertNodes(nodes: GraphNode[]): void {
    const s = this.stmt(
      `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line,
         docstring, signature, is_exported, is_test, visibility, is_async, is_static, is_abstract,
         decorators, metadata, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, name = excluded.name, qualified_name = excluded.qualified_name,
         file_path = excluded.file_path, language = excluded.language, start_line = excluded.start_line,
         end_line = excluded.end_line, docstring = excluded.docstring, signature = excluded.signature,
         is_exported = excluded.is_exported, is_test = excluded.is_test, visibility = excluded.visibility,
         is_async = excluded.is_async, is_static = excluded.is_static, is_abstract = excluded.is_abstract,
         decorators = excluded.decorators, metadata = excluded.metadata, updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    this.transaction(() => {
      for (const n of nodes) {
        s.run(
          n.id,
          n.kind,
          n.name,
          n.qualifiedName,
          n.filePath,
          n.language,
          n.startLine,
          n.endLine,
          n.docstring ?? null,
          n.signature ?? null,
          n.isExported ? 1 : 0,
          n.isTest ? 1 : 0,
          n.visibility ?? null,
          n.isAsync ? 1 : 0,
          n.isStatic ? 1 : 0,
          n.isAbstract ? 1 : 0,
          n.decorators ? JSON.stringify(n.decorators) : null,
          n.metadata ? JSON.stringify(n.metadata) : null,
          now,
        );
      }
    });
  }

  insertEdges(edges: GraphEdge[]): void {
    const s = this.stmt(
      'INSERT OR IGNORE INTO edges (source, target, kind, line, col, provenance) VALUES (?, ?, ?, ?, NULL, ?)',
    );
    this.transaction(() => {
      for (const e of edges)
        s.run(e.source, e.target, e.kind, e.line ?? null, e.provenance ?? null);
    });
  }

  insertUnresolved(refs: UnresolvedRef[]): void {
    const s = this.stmt(
      `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language, status, name_tail, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      for (const r of refs) {
        s.run(
          r.fromNodeId,
          r.referenceName,
          r.referenceKind,
          r.line,
          r.col,
          r.filePath,
          r.language,
          r.status,
          r.nameTail,
          r.metadata ? JSON.stringify(r.metadata) : null,
        );
      }
    });
  }

  unresolvedByStatus(
    status: RefStatus,
    limit?: number,
  ): UnresolvedRef[] {
    const rows =
      limit === undefined
        ? this.stmt(
            'SELECT * FROM unresolved_refs WHERE status = ? ORDER BY id',
          ).all(status)
        : this.stmt(
            'SELECT * FROM unresolved_refs WHERE status = ? ORDER BY id LIMIT ?',
          ).all(status, limit);
    return (rows as unknown as UnresolvedRow[]).map(toUnresolved);
  }

  markUnresolved(
    id: number,
    status: RefStatus,
    nameTail?: string,
  ): void {
    if (nameTail === undefined) {
      this.stmt('UPDATE unresolved_refs SET status = ? WHERE id = ?').run(
        status,
        id,
      );
    } else {
      this.stmt(
        'UPDATE unresolved_refs SET status = ?, name_tail = ? WHERE id = ?',
      ).run(status, nameTail, id);
    }
  }

  unresolvedByKinds(
    status: RefStatus,
    kinds: EdgeKind[],
  ): UnresolvedRef[] {
    if (kinds.length === 0) return [];
    const rows = this.stmt(
      `SELECT * FROM unresolved_refs WHERE status = ? AND reference_kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id`,
    ).all(status, ...kinds);
    return (rows as unknown as UnresolvedRow[]).map(toUnresolved);
  }

  unresolvedInFiles(
    paths: string[],
    status: RefStatus,
  ): UnresolvedRef[] {
    return this.unresolvedIn('file_path', paths, status);
  }

  failedByNameTails(tails: string[]): UnresolvedRef[] {
    return this.unresolvedIn('name_tail', tails, 'failed');
  }

  private unresolvedIn(
    column: 'file_path' | 'name_tail',
    values: string[],
    status: RefStatus,
  ): UnresolvedRef[] {
    const unique = [...new Set(values)];
    const rows: UnresolvedRow[] = [];
    for (let i = 0; i < unique.length; i += IN_CHUNK) {
      const chunk = unique.slice(i, i + IN_CHUNK);
      rows.push(
        ...(this.stmt(
          `SELECT * FROM unresolved_refs WHERE status = ? AND ${column} IN (${chunk.map(() => '?').join(',')})`,
        ).all(status, ...chunk) as unknown as UnresolvedRow[]),
      );
    }
    return rows.sort((a, b) => a.id - b.id).map(toUnresolved);
  }

  /** Records that `filePath`'s resolution read `deps` (idempotent). */
  insertResolutionDeps(filePath: string, kind: ResolutionDepKind, deps: Iterable<string>): void {
    const s = this.stmt('INSERT OR IGNORE INTO resolution_deps (file_path, kind, dep) VALUES (?, ?, ?)');
    this.transaction(() => {
      for (const d of deps) if (d !== filePath || kind !== 'file') s.run(filePath, kind, d);
    });
  }

  /** Files whose recorded resolution read one of `deps`. */
  filesDependingOn(kind: ResolutionDepKind, deps: string[]): Set<string> {
    const unique = [...new Set(deps)];
    const out = new Set<string>();
    for (let i = 0; i < unique.length; i += IN_CHUNK) {
      const chunk = unique.slice(i, i + IN_CHUNK);
      const rows = this.stmt(
        `SELECT DISTINCT file_path FROM resolution_deps WHERE kind = ? AND dep IN (${chunk.map(() => '?').join(',')})`,
      ).all(kind, ...chunk) as unknown as { file_path: string }[];
      for (const r of rows) out.add(r.file_path);
    }
    return out;
  }

  deleteResolutionDepsOf(paths: string[]): void {
    const unique = [...new Set(paths)];
    this.transaction(() => {
      for (let i = 0; i < unique.length; i += IN_CHUNK) {
        const chunk = unique.slice(i, i + IN_CHUNK);
        this.stmt(
          `DELETE FROM resolution_deps WHERE file_path IN (${chunk.map(() => '?').join(',')})`,
        ).run(...chunk);
      }
    });
  }

  deleteUnresolved(id: number): void {
    this.stmt('DELETE FROM unresolved_refs WHERE id = ?').run(id);
  }

  nodeById(id: string): GraphNode | undefined {
    const r = this.stmt('SELECT * FROM nodes WHERE id = ?').get(id) as
      NodeRow | undefined;
    return r ? toNode(r) : undefined;
  }

  nodesByName(name: string, limit: number): GraphNode[] {
    const rows = this.stmt(
      'SELECT * FROM nodes WHERE name = ? ORDER BY file_path, start_line LIMIT ?',
    ).all(name, limit);
    return (rows as unknown as NodeRow[]).map(toNode);
  }

  searchFts(
    matchExpr: string,
    limit: number,
    filter: SearchFilter = {},
  ): SearchRow[] {
    const f = searchFilterSql(filter);
    const rows = this.stmt(
      `${SEARCH_SELECT}, bm25(nodes_fts, ${BM25_ARGS}) AS bm25_score
       FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid ${SEARCH_JOIN}
       WHERE nodes_fts MATCH ?${f.sql}
       ORDER BY bm25_score, n.id LIMIT ?`,
    ).all(matchExpr, ...f.params, limit);
    return (rows as unknown as SearchRowRaw[]).map(toSearchRow);
  }

  searchSubstring(
    patterns: string[],
    limit: number,
    filter: SearchFilter = {},
    scope: SubstringScope = 'name',
  ): SearchRow[] {
    if (patterns.length === 0) return [];
    const f = searchFilterSql(filter);
    const one =
      scope === 'name'
        ? "lower(n.name) LIKE ? ESCAPE '\\'"
        : "(lower(COALESCE(n.docstring, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(n.signature, '')) LIKE ? ESCAPE '\\')";
    const per = scope === 'name' ? 1 : 2;
    const like = patterns.map(() => one).join(' AND ');
    const bound = patterns.flatMap((p) => {
      const v = `%${escapeLike(p.toLowerCase())}%`;
      return per === 1 ? [v] : [v, v];
    });
    try {
      const rows = this.stmt(
        `${SEARCH_SELECT} FROM nodes n ${SEARCH_JOIN}
         WHERE ${like}${f.sql}
         ORDER BY length(n.name), n.qualified_name, n.id LIMIT ?`,
      ).all(...bound, ...f.params, limit);
      return (rows as unknown as SearchRowRaw[]).map(toSearchRow);
    } catch {
      return [];
    }
  }

  filePaths(): string[] {
    return (
      this.stmt('SELECT path FROM files').all() as unknown as { path: string }[]
    ).map((r) => r.path);
  }

  /** Paths of files flagged as tests. */
  testFilePaths(): Set<string> {
    const rows = this.stmt(
      'SELECT path FROM files WHERE is_test = 1',
    ).all() as unknown as { path: string }[];
    return new Set(rows.map((r) => r.path));
  }

  /** Paths of files flagged as generated. */
  generatedFilePaths(): Set<string> {
    const rows = this.stmt('SELECT path FROM files WHERE generated = 1').all() as unknown as { path: string }[];
    return new Set(rows.map((r) => r.path));
  }

  /** Paths of files flagged as tests or generated. */
  excludedFilePaths(): Set<string> {
    const rows = this.stmt(
      'SELECT path FROM files WHERE is_test = 1 OR generated = 1',
    ).all() as unknown as { path: string }[];
    return new Set(rows.map((r) => r.path));
  }

  /** Lean projection of every node (no docstring/signature) for building in-memory indexes. */
  nodeSummaries(): NodeSummary[] {
    const rows = this.stmt(
      `SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, is_exported, metadata
       FROM nodes ORDER BY file_path, start_line, id`,
    ).all() as unknown as SummaryRow[];
    return rows.map((r) => {
      const n: NodeSummary = {
        id: r.id,
        kind: r.kind as NodeKind,
        name: r.name,
        qualifiedName: r.qualified_name,
        filePath: r.file_path,
        language: r.language as CodeGraphLanguage,
        startLine: r.start_line,
        endLine: r.end_line,
        isExported: r.is_exported === 1,
      };
      if (r.metadata !== null)
        n.metadata = JSON.parse(r.metadata) as RefMetadata;
      return n;
    });
  }

  edgesOfKinds(kinds: EdgeKind[]): GraphEdge[] {
    if (kinds.length === 0) return [];
    const rows = this.stmt(
      `SELECT source, target, kind FROM edges WHERE kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id`,
    ).all(...kinds) as unknown as {
      source: string;
      target: string;
      kind: string;
    }[];
    return rows.map((r) => ({
      source: r.source,
      target: r.target,
      kind: r.kind as EdgeKind,
    }));
  }

  nodesInFile(path: string): GraphNode[] {
    const rows = this.stmt(
      'SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line, id',
    ).all(path);
    return (rows as unknown as NodeRow[]).map(toNode);
  }

  edgesFrom(id: string, kinds?: EdgeKind[]): GraphEdge[] {
    return this.edgesBy('source', id, kinds);
  }

  edgesTo(id: string, kinds?: EdgeKind[]): GraphEdge[] {
    return this.edgesBy('target', id, kinds);
  }

  edgesFromMany(ids: string[], kinds?: EdgeKind[]): GraphEdge[] {
    return this.edgesByMany('source', ids, kinds);
  }

  edgesToMany(ids: string[], kinds?: EdgeKind[]): GraphEdge[] {
    return this.edgesByMany('target', ids, kinds);
  }

  private edgesByMany(
    column: 'source' | 'target',
    ids: string[],
    kinds?: EdgeKind[],
  ): GraphEdge[] {
    const unique = [...new Set(ids)];
    const kindSql =
      kinds && kinds.length > 0
        ? ` AND kind IN (${kinds.map(() => '?').join(',')})`
        : '';
    const kindArgs = kinds && kinds.length > 0 ? kinds : [];
    const rows: (EdgeRow & { id: number })[] = [];
    for (let i = 0; i < unique.length; i += IN_CHUNK) {
      const chunk = unique.slice(i, i + IN_CHUNK);
      rows.push(
        ...(this.stmt(
          `SELECT id, source, target, kind, line, provenance FROM edges WHERE ${column} IN (${chunk.map(() => '?').join(',')})${kindSql}`,
        ).all(...chunk, ...kindArgs) as unknown as (EdgeRow & {
          id: number;
        })[]),
      );
    }
    return rows.sort((a, b) => a.id - b.id).map(toEdge);
  }

  private edgesBy(
    column: 'source' | 'target',
    id: string,
    kinds?: EdgeKind[],
  ): GraphEdge[] {
    const cols = 'source, target, kind, line, provenance';
    const rows =
      kinds && kinds.length > 0
        ? this.stmt(
            `SELECT ${cols} FROM edges WHERE ${column} = ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id`,
          ).all(id, ...kinds)
        : this.stmt(
            `SELECT ${cols} FROM edges WHERE ${column} = ? ORDER BY id`,
          ).all(id);
    return (rows as unknown as EdgeRow[]).map(toEdge);
  }

  fileRecords(): FileRow[] {
    const rows = this.stmt('SELECT * FROM files ORDER BY path').all() as unknown as {
      path: string;
      content_hash: string;
      language: string;
      size: number;
      modified_at: number;
      indexed_at: number;
      node_count: number;
      errors: string | null;
      generated: number;
      is_test: number;
    }[];
    return rows.map((r) => {
      const f: FileRow = {
        path: r.path,
        contentHash: r.content_hash,
        language: r.language as CodeGraphLanguage,
        size: r.size,
        modifiedAt: r.modified_at,
        indexedAt: r.indexed_at,
        nodeCount: r.node_count,
        generated: r.generated === 1,
        isTest: r.is_test === 1,
      };
      if (r.errors !== null) f.errors = JSON.parse(r.errors) as string[];
      return f;
    });
  }

  setFileModifiedAt(path: string, modifiedAt: number): void {
    this.stmt('UPDATE files SET modified_at = ? WHERE path = ?').run(modifiedAt, path);
  }

  /** Files with at least one node, per language (what a full index reports as `languages`). */
  languageCounts(): Partial<Record<CodeGraphLanguage, number>> {
    const rows = this.stmt(
      'SELECT language, COUNT(*) AS c FROM files WHERE node_count > 0 GROUP BY language ORDER BY language',
    ).all() as unknown as { language: string; c: number }[];
    const out: Partial<Record<CodeGraphLanguage, number>> = {};
    for (const r of rows) out[r.language as CodeGraphLanguage] = r.c;
    return out;
  }

  nodeRefsInFiles(paths: string[]): { id: string; name: string; kind: NodeKind; filePath: string }[] {
    return this.nodeRefsWhere('file_path', paths);
  }

  nodeRefsByNames(names: string[]): { id: string; name: string; kind: NodeKind; filePath: string }[] {
    return this.nodeRefsWhere('name', names);
  }

  private nodeRefsWhere(
    column: 'file_path' | 'name',
    values: string[],
  ): { id: string; name: string; kind: NodeKind; filePath: string }[] {
    const unique = [...new Set(values)];
    const out: { id: string; name: string; kind: NodeKind; filePath: string }[] = [];
    for (let i = 0; i < unique.length; i += IN_CHUNK) {
      const chunk = unique.slice(i, i + IN_CHUNK);
      const rows = this.stmt(
        `SELECT id, name, kind, file_path FROM nodes WHERE ${column} IN (${chunk.map(() => '?').join(',')}) ORDER BY id`,
      ).all(...chunk) as unknown as { id: string; name: string; kind: string; file_path: string }[];
      for (const r of rows)
        out.push({ id: r.id, name: r.name, kind: r.kind as NodeKind, filePath: r.file_path });
    }
    return out;
  }

  /**
   * Files owning a resolved edge that points at one of `ids` (the source file, or for
   * `decorates` the decorated node's file, since that edge is stored decorator → decorated).
   */
  referencingFiles(ids: string[]): Set<string> {
    const unique = [...new Set(ids)];
    const out = new Set<string>();
    for (let i = 0; i < unique.length; i += IN_CHUNK) {
      const chunk = unique.slice(i, i + IN_CHUNK);
      const marks = chunk.map(() => '?').join(',');
      const rows = this.stmt(
        `SELECT n.file_path AS path FROM edges e JOIN nodes n ON n.id = e.source
           WHERE e.target IN (${marks}) AND e.kind NOT IN ('contains', 'decorates')
         UNION
         SELECT n.file_path AS path FROM edges e JOIN nodes n ON n.id = e.target
           WHERE e.source IN (${marks}) AND e.kind = 'decorates'`,
      ).all(...chunk, ...chunk) as unknown as { path: string }[];
      for (const r of rows) out.add(r.path);
    }
    return out;
  }

  /** Drops every edge produced from the nodes' own file: extraction edges and resolved refs. */
  deleteEdgesOwnedBy(ids: string[]): void {
    const unique = [...new Set(ids)];
    this.transaction(() => {
      for (let i = 0; i < unique.length; i += IN_CHUNK) {
        const chunk = unique.slice(i, i + IN_CHUNK);
        const marks = chunk.map(() => '?').join(',');
        this.stmt(
          `DELETE FROM edges WHERE (source IN (${marks}) AND kind != 'decorates')
             OR (target IN (${marks}) AND kind = 'decorates')`,
        ).run(...chunk, ...chunk);
      }
    });
  }

  /** Go structural `implements` edges are all derived globally by `inferGoImplements`. */
  deleteGoInferredImplements(): void {
    this.stmt(
      `DELETE FROM edges WHERE kind = 'implements' AND provenance = 'heuristic'
         AND source IN (SELECT id FROM nodes WHERE language = 'go')`,
    ).run();
  }

  deleteUnresolvedInFiles(paths: string[]): void {
    const unique = [...new Set(paths)];
    this.transaction(() => {
      for (let i = 0; i < unique.length; i += IN_CHUNK) {
        const chunk = unique.slice(i, i + IN_CHUNK);
        this.stmt(
          `DELETE FROM unresolved_refs WHERE file_path IN (${chunk.map(() => '?').join(',')})`,
        ).run(...chunk);
      }
    });
  }

  /** Direct children (subdirs + files with a file node) of `dir` ('' is the project root), dirs first. */
  viewDirChildren(dir: string): ViewChildRow[] {
    const bounds = dir === '' ? [] : dirRange(dir);
    // SQL counts characters and JS UTF-16 units: the prefix length must come from SQL.
    const rows = this.stmt(
      `WITH p(plen) AS (SELECT CASE WHEN ?1 = '' THEN 0 ELSE length(?1) + 1 END)
       SELECT key, is_dir, files, symbols, fid, language, is_test, generated,
         CASE WHEN is_dir THEN children
              ELSE (SELECT COUNT(*) FROM edges c WHERE c.source = fid AND c.kind = 'contains') END AS children
       FROM (
         SELECT CASE WHEN slash > 0 THEN substr(path, 1, plen + slash - 1) ELSE path END AS key,
                slash > 0 AS is_dir,
                COUNT(*) AS files,
                SUM(MAX(node_count - 1, 0)) AS symbols,
                COUNT(DISTINCT CASE WHEN slash > 0 THEN substr(path, plen + slash + 1,
                  instr(substr(path, plen + slash + 1) || '/', '/') - 1) END) AS children,
                MAX(fid) AS fid, MAX(language) AS language, MAX(is_test) AS is_test,
                MIN(generated) AS generated
         FROM (
           SELECT f.path, f.node_count, f.language, f.is_test, f.generated, n.id AS fid, p.plen,
                  instr(substr(f.path, p.plen + 1), '/') AS slash
           FROM p CROSS JOIN files f JOIN nodes n ON n.file_path = f.path AND n.kind = 'file'
           ${dir === '' ? '' : 'WHERE f.path >= ?2 AND f.path < ?3'}
         )
         GROUP BY key
       )`,
    ).all(dir, ...bounds) as unknown as {
      key: string;
      is_dir: number;
      files: number;
      symbols: number;
      children: number;
      fid: string;
      language: string;
      is_test: number;
      generated: number;
    }[];
    const out = rows.map((r) => {
      const row: ViewChildRow = {
        path: r.key,
        isDir: r.is_dir === 1,
        fileCount: r.files,
        symbolCount: r.symbols,
        childCount: r.children,
      };
      if (r.generated === 1) row.generated = true;
      if (r.is_dir !== 1) {
        row.fileId = r.fid;
        row.language = r.language as CodeGraphLanguage;
        if (r.is_test === 1) row.isTest = true;
      }
      return row;
    });
    return out.sort(
      (a, b) =>
        Number(b.isDir) - Number(a.isDir) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
  }

  /**
   * Real edges between the project's root entries, as `source → target` weights.
   * Directories are keyed `name/`, root files by their path.
   */
  viewTopLevelEdges(kinds: EdgeKind[]): ViewEdgeRow[] {
    if (kinds.length === 0) return [];
    const top = (c: string): string => `substr(${c}, 1, instr(${c} || '/', '/'))`;
    // Each node's root entry is resolved once into a temp map, so the edge scan joins small
    // integer keys instead of slicing and grouping two paths per edge (~20% faster on 150k).
    // Keys come from `files` like the root entries themselves; nodes are matched by key.
    this.db.exec(
      `CREATE TEMP TABLE ${VIEW_TOP_KEYS} (k INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE);
       CREATE TEMP TABLE ${VIEW_TOP_NODES} (id TEXT PRIMARY KEY, k INTEGER NOT NULL) WITHOUT ROWID;`,
    );
    try {
      this.db.exec(
        `INSERT INTO ${VIEW_TOP_KEYS} (key) SELECT DISTINCT ${top('path')} FROM files;
         INSERT INTO ${VIEW_TOP_NODES} SELECT n.id, k.k FROM nodes n ${this.byIdFile()}
           JOIN ${VIEW_TOP_KEYS} k ON k.key = ${top('n.file_path')} ORDER BY n.id;`,
      );
      // The outer loop walks the map in id order, so the edges are read in index order too.
      return this.db
        .prepare(
          `SELECT ks.key AS source, kt.key AS target, w AS weight FROM (
             SELECT a.k AS s, b.k AS t, COUNT(*) AS w
             FROM ${VIEW_TOP_NODES} a CROSS JOIN edges e INDEXED BY idx_edges_identity CROSS JOIN ${VIEW_TOP_NODES} b
             WHERE e.source = a.id AND b.id = e.target AND e.kind IN (${kinds.map(() => '?').join(',')}) AND a.k <> b.k
             GROUP BY a.k, b.k
           ) JOIN ${VIEW_TOP_KEYS} ks ON ks.k = s JOIN ${VIEW_TOP_KEYS} kt ON kt.k = t
           ORDER BY 1, 2`,
        )
        .all(...kinds) as unknown as ViewEdgeRow[];
    } finally {
      this.db.exec(`DROP TABLE IF EXISTS ${VIEW_TOP_NODES}; DROP TABLE IF EXISTS ${VIEW_TOP_KEYS};`);
    }
  }

  /**
   * Real edges with at least one endpoint in the scope, each endpoint folded by `rep`,
   * counted once per edge. Self pairs and endpoints `rep` drops are left out.
   */
  viewAggregateEdges(query: ViewEdgeQuery): ViewEdgeRow[] {
    if (query.kinds.length === 0) return [];
    this.ensureViewFunctions();
    const byDir = 'dir' in query.scope;
    const bounds = 'dir' in query.scope ? dirRange(query.scope.dir) : [query.scope.file];
    const inN = byDir ? 'file_path >= ? AND file_path < ?' : 'file_path = ?';
    const inO = byDir ? 'o.file_path >= ? AND o.file_path < ?' : 'o.file_path = ?';
    const kinds = query.kinds.map(() => '?').join(',');
    this.viewRep = query.rep;
    this.viewIn = query.inScope;
    // A directory holding every node (a lone `src/`) has no incoming edge from outside: the
    // second arm would only probe the target index once per node for nothing.
    const incoming = !byDir || this.hasNodesOutside(bounds[0] as string, bounds[1] as string);
    try {
      // The scoped side is materialized so `rep` runs once per node rather than once per edge.
      const outArm = `SELECT n.r AS s, ${VIEW_REP_FN}(o.file_path, o.id) AS t
           FROM n CROSS JOIN edges e CROSS JOIN nodes o ${this.byIdFile()}
           WHERE e.source = n.id AND e.kind IN (${kinds}) AND o.id = e.target`;
      const inArm = `SELECT ${VIEW_REP_FN}(o.file_path, o.id), n.r
           FROM n CROSS JOIN edges e CROSS JOIN nodes o ${this.byIdFile()}
           WHERE e.target = n.id AND e.kind IN (${kinds}) AND o.id = e.source
             AND NOT (${inO} AND ${VIEW_IN_FN}(o.file_path))`;
      const rows = this.stmt(
        `WITH n AS MATERIALIZED (
           SELECT id, ${VIEW_REP_FN}(file_path, id) AS r FROM nodes WHERE ${inN} AND ${VIEW_IN_FN}(file_path)
         )
         SELECT s AS source, t AS target, COUNT(*) AS weight FROM (
           ${incoming ? `${outArm}\n           UNION ALL\n           ${inArm}` : outArm}
         ) GROUP BY s, t ORDER BY s, t`,
      ).all(...bounds, ...query.kinds, ...(incoming ? [...query.kinds, ...bounds] : [])) as unknown as {
        source: string | null;
        target: string | null;
        weight: number;
      }[];
      // Filtering here rather than in SQL: a WHERE on s/t is pushed into both UNION arms
      // and calls the rep function again for every reference.
      return rows.filter((r): r is ViewEdgeRow => r.source !== null && r.target !== null && r.source !== r.target);
    } finally {
      this.viewRep = () => null;
      this.viewIn = () => false;
    }
  }

  private hasNodesOutside(from: string, to: string): boolean {
    return (
      this.stmt('SELECT 1 FROM nodes WHERE file_path < ? LIMIT 1').get(from) !== undefined ||
      this.stmt('SELECT 1 FROM nodes WHERE file_path >= ? LIMIT 1').get(to) !== undefined
    );
  }

  private idFileIndex: boolean | undefined;

  // Without ANALYZE stats SQLite picks the primary-key index and probes the table for
  // file_path on every edge; graphs built before the index existed fall back to that.
  private byIdFile(): string {
    this.idFileIndex ??=
      this.stmt("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_id_file'").get() !==
      undefined;
    return this.idFileIndex ? 'INDEXED BY idx_nodes_id_file' : '';
  }

  private viewRep: ViewEdgeQuery['rep'] = () => null;
  private viewIn: ViewEdgeQuery['inScope'] = () => false;
  private viewFunctions = false;

  // The SQL functions call through fields so they are registered once per connection.
  private ensureViewFunctions(): void {
    if (this.viewFunctions) return;
    this.db.function(VIEW_REP_FN, (filePath, id) => this.viewRep(String(filePath), String(id)));
    this.db.function(VIEW_IN_FN, (filePath) => (this.viewIn(String(filePath)) ? 1 : 0));
    this.viewFunctions = true;
  }

  nodeLocations(ids: string[]): { id: string; kind: NodeKind; filePath: string }[] {
    if (ids.length === 0) return [];
    const rows = this.stmt(
      'SELECT id, kind, file_path FROM nodes WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
    ).all(JSON.stringify([...new Set(ids)])) as unknown as { id: string; kind: string; file_path: string }[];
    return rows.map((r) => ({ id: r.id, kind: r.kind as NodeKind, filePath: r.file_path }));
  }

  /** `contains` parent of every node in the files (child id → parent id). */
  containsParents(filePaths: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (filePaths.length === 0) return out;
    const rows = this.stmt(
      `SELECT e.target AS child, e.source AS parent
       FROM nodes n JOIN edges e ON e.target = n.id AND e.kind = 'contains'
       WHERE n.file_path IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify([...new Set(filePaths)])) as unknown as { child: string; parent: string }[];
    for (const r of rows) out.set(r.child, r.parent);
    return out;
  }

  containsChildren(parentId: string, offset: number, limit: number): GraphNode[] {
    const rows = this.stmt(
      `SELECT n.* FROM edges e JOIN nodes n ON n.id = e.target
       WHERE e.source = ? AND e.kind = 'contains'
       ORDER BY n.start_line, n.id LIMIT ? OFFSET ?`,
    ).all(parentId, limit, offset);
    return (rows as unknown as NodeRow[]).map(toNode);
  }

  /** Number of `contains` children per id; ids without children are absent. */
  containsChildCounts(ids: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    const rows = this.stmt(
      `SELECT source, COUNT(*) AS c FROM edges
       WHERE source IN (SELECT value FROM json_each(?)) AND kind = 'contains' GROUP BY source`,
    ).all(JSON.stringify([...new Set(ids)])) as unknown as { source: string; c: number }[];
    for (const r of rows) out.set(r.source, r.c);
    return out;
  }

  fileNodeIds(paths: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (paths.length === 0) return out;
    const rows = this.stmt(
      `SELECT file_path, id FROM nodes
       WHERE file_path IN (SELECT value FROM json_each(?)) AND kind = 'file'`,
    ).all(JSON.stringify([...new Set(paths)])) as unknown as { file_path: string; id: string }[];
    for (const r of rows) out.set(r.file_path, r.id);
    return out;
  }

  dirSummary(dir: string): DirSummary {
    const rows = this.stmt(
      `SELECT f.language AS language, COUNT(*) AS files, SUM(MAX(f.node_count - 1, 0)) AS symbols
       FROM files f JOIN nodes n ON n.file_path = f.path AND n.kind = 'file'
       WHERE f.path >= ? AND f.path < ? GROUP BY f.language ORDER BY f.language`,
    ).all(...dirRange(dir)) as unknown as { language: string; files: number; symbols: number }[];
    const out: DirSummary = { fileCount: 0, symbolCount: 0, languages: {} };
    for (const r of rows) {
      out.fileCount += r.files;
      out.symbolCount += r.symbols;
      out.languages[r.language as CodeGraphLanguage] = r.files;
    }
    return out;
  }

  nodesByIds(ids: string[]): GraphNode[] {
    if (ids.length === 0) return [];
    const rows = this.stmt('SELECT * FROM nodes WHERE id IN (SELECT value FROM json_each(?))').all(
      JSON.stringify([...new Set(ids)]),
    );
    return (rows as unknown as NodeRow[]).map(toNode);
  }

  /** Files imported by `path` (excluding itself), sorted. */
  importedFilePaths(path: string): string[] {
    return this.importPaths('source', 'target', path);
  }

  /** Files importing `path` (excluding itself), sorted. */
  importingFilePaths(path: string): string[] {
    return this.importPaths('target', 'source', path);
  }

  private importPaths(own: 'source' | 'target', other: 'source' | 'target', path: string): string[] {
    const rows = this.stmt(
      `SELECT DISTINCT o.file_path AS p
       FROM nodes n JOIN edges e ON e.${own} = n.id AND e.kind = 'imports' JOIN nodes o ON o.id = e.${other}
       WHERE n.file_path = ? AND o.file_path <> ? ORDER BY p`,
    ).all(path, path) as unknown as { p: string }[];
    return rows.map((r) => r.p);
  }

  fileSymbolCount(path: string): number {
    return (
      this.stmt("SELECT COUNT(*) AS c FROM nodes WHERE file_path = ? AND kind <> 'file'").get(path) as {
        c: number;
      }
    ).c;
  }

  /** File nodes whose path contains `text` (case-insensitive), shortest path first. */
  searchFiles(text: string, limit: number): GraphNode[] {
    if (text === '' || limit <= 0) return [];
    const rows = this.stmt(
      `SELECT * FROM nodes WHERE kind = 'file' AND lower(file_path) LIKE ? ESCAPE '\\'
       ORDER BY length(file_path), file_path LIMIT ?`,
    ).all(`%${escapeLike(text.toLowerCase())}%`, limit);
    return (rows as unknown as NodeRow[]).map(toNode);
  }

  getMeta(key: string): string | undefined {
    const r = this.stmt('SELECT value FROM project_metadata WHERE key = ?').get(
      key,
    ) as { value: string } | undefined;
    return r?.value;
  }

  setMeta(key: string, value: string): void {
    this.stmt(
      `INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, Date.now());
  }

  counts(): { nodes: number; edges: number; files: number } {
    const c = (t: string): number =>
      (this.stmt(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    return { nodes: c('nodes'), edges: c('edges'), files: c('files') };
  }
}
