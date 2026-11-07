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
  status: 'pending' | 'failed';
  nameTail: string;
  metadata?: RefMetadata;
}

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
    status: r.status as 'pending' | 'failed',
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
    status: 'pending' | 'failed',
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
    status: 'pending' | 'failed',
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
    status: 'pending' | 'failed',
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
    status: 'pending' | 'failed',
  ): UnresolvedRef[] {
    return this.unresolvedIn('file_path', paths, status);
  }

  failedByNameTails(tails: string[]): UnresolvedRef[] {
    return this.unresolvedIn('name_tail', tails, 'failed');
  }

  private unresolvedIn(
    column: 'file_path' | 'name_tail',
    values: string[],
    status: 'pending' | 'failed',
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
