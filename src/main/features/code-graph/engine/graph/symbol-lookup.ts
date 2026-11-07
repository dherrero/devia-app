import type {
  GraphNode,
  NodeKind,
} from '../../../../../shared/domain/code-graph';
import type { GraphQueries } from '../db/queries';

export interface LookupOptions {
  /** Restrict to files whose root-relative path ends with this (segment-aligned). */
  file?: string;
  kind?: NodeKind;
  /** Root-relative path used to rank same-directory matches first. */
  near?: string;
}

const CANDIDATE_LIMIT = 5000;

function pathMatches(filePath: string, suffix: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  const s = suffix.replace(/\\/g, '/').replace(/^\.?\//, '');
  return p === s || p.endsWith(`/${s}`);
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function matchesName(n: GraphNode, query: string): boolean {
  return (
    n.name === query ||
    n.qualifiedName === query ||
    n.qualifiedName.endsWith(`.${query}`)
  );
}

function candidatesFor(db: GraphQueries, query: string): GraphNode[] {
  const last = query.slice(query.lastIndexOf('.') + 1);
  const byId = new Map<string, GraphNode>();
  for (const n of db.nodesByName(last, CANDIDATE_LIMIT)) byId.set(n.id, n);
  if (last !== query)
    for (const n of db.nodesByName(query, CANDIDATE_LIMIT)) byId.set(n.id, n);
  return [...byId.values()].filter((n) => matchesName(n, query));
}

function rank(nodes: GraphNode[], query: string, near?: string): GraphNode[] {
  const nearDir = near === undefined ? undefined : dirOf(near);
  const score = (n: GraphNode): number[] => [
    n.qualifiedName === query ? 0 : 1,
    n.isExported ? 0 : 1,
    nearDir !== undefined && dirOf(n.filePath) === nearDir ? 0 : 1,
  ];
  return [...nodes].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) {
      const d = (sa[i] ?? 0) - (sb[i] ?? 0);
      if (d !== 0) return d;
    }
    if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function fileNodesForPath(db: GraphQueries, query: string): GraphNode[] {
  const matched = db.filePaths().filter((p) => pathMatches(p, query));
  return matched
    .sort()
    .flatMap((p) => db.nodesInFile(p).filter((n) => n.kind === 'file'));
}

/**
 * Resolves `name`, `Class.method`, `file.ts#name` and qualified-name suffixes
 * (matched at `.` boundaries) to every matching node, best match first.
 */
export function lookupSymbol(
  db: GraphQueries,
  query: string,
  opts: LookupOptions = {},
): GraphNode[] {
  const q = query.trim();
  if (q === '') return [];
  const wantFiles = opts.kind === 'file';
  const keep = (n: GraphNode): boolean =>
    (opts.kind === undefined ? n.kind !== 'file' : n.kind === opts.kind) &&
    (opts.file === undefined || pathMatches(n.filePath, opts.file));

  const hash = q.indexOf('#');
  if (hash > 0 && hash < q.length - 1) {
    const filePart = q.slice(0, hash);
    const name = q.slice(hash + 1);
    const hits = candidatesFor(db, name).filter(
      (n) => keep(n) && pathMatches(n.filePath, filePart),
    );
    return rank(hits, name, opts.near);
  }

  if (q.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(q)) {
    const files = fileNodesForPath(db, q).filter(
      (n) =>
        (opts.kind === undefined || wantFiles) &&
        (opts.file === undefined || pathMatches(n.filePath, opts.file)),
    );
    if (files.length > 0) return files;
  }

  return rank(candidatesFor(db, q).filter(keep), q, opts.near);
}
