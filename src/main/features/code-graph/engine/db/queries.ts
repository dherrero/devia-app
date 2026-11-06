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
