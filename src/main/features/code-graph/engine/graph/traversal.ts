import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
} from '../../../../../shared/domain/code-graph';
import type { GraphQueries } from '../db/queries';

export interface TraversalOptions {
  depth?: number;
  limit?: number;
}

export interface CallOptions extends TraversalOptions {
  /** Also treat overrides/implementations as callers and callees of their base. */
  includeInheritance?: boolean;
}

export interface TraversalHit {
  node: GraphNode;
  edge: GraphEdge;
  depth: number;
}

export interface ImpactResult {
  root: GraphNode;
  byDepth: { depth: number; nodes: GraphNode[] }[];
  files: string[];
  truncated: boolean;
}

const CALL_KINDS: EdgeKind[] = ['calls', 'instantiates'];
const INHERIT_KINDS: EdgeKind[] = ['overrides', 'implements'];
const IMPACT_KINDS: EdgeKind[] = [
  'calls',
  'references',
  'extends',
  'implements',
  'instantiates',
  'imports',
  'type_of',
  'overrides',
  'decorates',
];
const PATH_KINDS: EdgeKind[] = [
  'calls',
  'instantiates',
  'extends',
  'implements',
  'references',
  'imports',
  'overrides',
];
const CONSTRUCTOR_NAMES = new Set(['constructor', '__init__', '<init>']);

interface Candidate {
  id: string;
  edge: GraphEdge;
}

class NodeCache {
  private readonly nodes = new Map<string, GraphNode | undefined>();
  private readonly fileNodes = new Map<string, string | undefined>();

  constructor(private readonly db: GraphQueries) {}

  get(id: string): GraphNode | undefined {
    if (!this.nodes.has(id)) this.nodes.set(id, this.db.nodeById(id));
    return this.nodes.get(id);
  }

  fileNodeId(filePath: string): string | undefined {
    if (!this.fileNodes.has(filePath)) {
      this.fileNodes.set(
        filePath,
        this.db.nodesInFile(filePath).find((n) => n.kind === 'file')?.id,
      );
    }
    return this.fileNodes.get(filePath);
  }
}

function constructorClassIds(
  db: GraphQueries,
  cache: NodeCache,
  frontier: string[],
): string[] {
  const methods = frontier.filter((id) => cache.get(id)?.kind === 'method');
  if (methods.length === 0) return [];
  const parentOf = new Map<string, string>();
  for (const e of db.edgesToMany(methods, ['contains']))
    parentOf.set(e.target, e.source);
  const classIds: string[] = [];
  for (const id of methods) {
    const parentId = parentOf.get(id);
    const method = cache.get(id);
    const parent = parentId === undefined ? undefined : cache.get(parentId);
    if (!method || !parentId || !parent) continue;
    if (CONSTRUCTOR_NAMES.has(method.name) || method.name === parent.name)
      classIds.push(parentId);
  }
  return classIds;
}

function callerCandidates(
  db: GraphQueries,
  cache: NodeCache,
  frontier: string[],
  inheritance: boolean,
): Candidate[] {
  const kinds = inheritance ? [...CALL_KINDS, ...INHERIT_KINDS] : CALL_KINDS;
  const out = db
    .edgesToMany(frontier, kinds)
    .map((e) => ({ id: e.source, edge: e }));
  const classIds = constructorClassIds(db, cache, frontier);
  if (classIds.length > 0)
    for (const e of db.edgesToMany(classIds, ['instantiates']))
      out.push({ id: e.source, edge: e });
  return out;
}

function calleeCandidates(
  db: GraphQueries,
  frontier: string[],
  inheritance: boolean,
): Candidate[] {
  const out = db
    .edgesFromMany(frontier, CALL_KINDS)
    .map((e) => ({ id: e.target, edge: e }));
  if (inheritance)
    for (const e of db.edgesToMany(frontier, INHERIT_KINDS))
      out.push({ id: e.source, edge: e });
  return out;
}

function bfsCalls(
  db: GraphQueries,
  nodeId: string,
  opts: CallOptions,
  expand: (cache: NodeCache, frontier: string[]) => Candidate[],
): TraversalHit[] {
  const maxDepth = opts.depth ?? 1;
  const limit = opts.limit ?? 100;
  const cache = new NodeCache(db);
  const visited = new Set<string>([nodeId]);
  const hits: TraversalHit[] = [];
  let frontier = [nodeId];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const c of expand(cache, frontier)) {
      if (visited.has(c.id)) continue;
      const node = cache.get(c.id);
      if (!node) continue;
      visited.add(c.id);
      hits.push({ node, edge: c.edge, depth });
      if (hits.length >= limit) return hits;
      next.push(c.id);
    }
    frontier = next;
  }
  return hits;
}

export function getCallers(
  db: GraphQueries,
  nodeId: string,
  opts: CallOptions = {},
): TraversalHit[] {
  return bfsCalls(db, nodeId, opts, (cache, frontier) =>
    callerCandidates(db, cache, frontier, opts.includeInheritance ?? false),
  );
}

export function getCallees(
  db: GraphQueries,
  nodeId: string,
  opts: CallOptions = {},
): TraversalHit[] {
  return bfsCalls(db, nodeId, opts, (_cache, frontier) =>
    calleeCandidates(db, frontier, opts.includeInheritance ?? false),
  );
}

export function getImpact(
  db: GraphQueries,
  nodeId: string,
  opts: TraversalOptions = {},
): ImpactResult {
  const root = db.nodeById(nodeId);
  if (!root) throw new Error(`node not found: ${nodeId}`);
  const maxDepth = opts.depth ?? 3;
  const limit = opts.limit ?? 200;
  const cache = new NodeCache(db);
  const visited = new Set<string>([root.id]);
  let frontier = [root.id];
  if (root.kind === 'file') {
    for (const n of db.nodesInFile(root.filePath)) {
      if (visited.has(n.id)) continue;
      visited.add(n.id);
      frontier.push(n.id);
    }
  }
  const files = new Set<string>([root.filePath]);
  const byDepth: ImpactResult['byDepth'] = [];
  let total = 0;
  let truncated = false;

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const candidates = db
      .edgesToMany(frontier, IMPACT_KINDS)
      .map((e) => e.source);
    // An import edge targets the file node, so an exported symbol is reached
    // through the imports of its own file.
    const fileIds = new Set<string>();
    for (const id of frontier) {
      const n = cache.get(id);
      if (!n || n.kind === 'file' || !n.isExported) continue;
      const fid = cache.fileNodeId(n.filePath);
      if (fid !== undefined) fileIds.add(fid);
    }
    if (fileIds.size > 0)
      for (const e of db.edgesToMany([...fileIds], ['imports']))
        candidates.push(e.source);

    const level: GraphNode[] = [];
    for (const id of candidates) {
      if (visited.has(id)) continue;
      const node = cache.get(id);
      if (!node) continue;
      if (total >= limit) {
        truncated = true;
        break;
      }
      visited.add(id);
      level.push(node);
      files.add(node.filePath);
      total++;
    }
    if (level.length > 0) byDepth.push({ depth, nodes: level });
    if (truncated) break;
    frontier = level.map((n) => n.id);
  }
  return { root, byDepth, files: [...files], truncated };
}

export function findPath(
  db: GraphQueries,
  fromId: string,
  toId: string,
  opts: { maxDepth?: number } = {},
): GraphNode[] | null {
  const maxDepth = opts.maxDepth ?? 8;
  const from = db.nodeById(fromId);
  if (!from || !db.nodeById(toId)) return null;
  if (fromId === toId) return [from];
  const parent = new Map<string, string>();
  const visited = new Set<string>([fromId]);
  let frontier = [fromId];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    frontier.sort();
    const edges = db
      .edgesFromMany(frontier, PATH_KINDS)
      .sort((a, b) =>
        a.source !== b.source
          ? a.source < b.source
            ? -1
            : 1
          : a.target < b.target
            ? -1
            : a.target > b.target
              ? 1
              : 0,
      );
    const next: string[] = [];
    for (const e of edges) {
      if (visited.has(e.target)) continue;
      visited.add(e.target);
      parent.set(e.target, e.source);
      if (e.target === toId) return buildPath(db, parent, fromId, toId);
      next.push(e.target);
    }
    frontier = next;
  }
  return null;
}

function buildPath(
  db: GraphQueries,
  parent: Map<string, string>,
  fromId: string,
  toId: string,
): GraphNode[] | null {
  const ids = [toId];
  for (let cur = toId; cur !== fromId;) {
    const p = parent.get(cur);
    if (p === undefined) return null;
    ids.push(p);
    cur = p;
  }
  ids.reverse();
  const nodes: GraphNode[] = [];
  for (const id of ids) {
    const n = db.nodeById(id);
    if (!n) return null;
    nodes.push(n);
  }
  return nodes;
}
