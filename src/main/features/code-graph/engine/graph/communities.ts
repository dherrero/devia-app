import type { EdgeKind } from '../../../../../shared/domain/code-graph';
import type { GraphQueries } from '../db/queries';

export interface CommunityOptions {
  seed?: number;
  maxIterations?: number;
}

export interface CommunityResult {
  /** Keyed by root-relative `/` file path. */
  assignments: Map<string, number>;
  count: number;
}

export interface Hub {
  nodeId: string;
  degree: number;
  score: number;
}

const COMMUNITIES_KEY = 'communities';
const COUNT_KEY = 'community_count';
const HUBS_KEY = 'hubs';

/** How many hubs a full index persists for the graph view (flags, per-dir top hubs). */
export const PERSISTED_HUBS = 200;

const EDGE_WEIGHTS: Partial<Record<EdgeKind, number>> = {
  imports: 1,
  calls: 2,
  instantiates: 2,
  extends: 3,
  implements: 3,
  references: 1,
};

const HUB_KINDS: EdgeKind[] = [
  'calls',
  'instantiates',
  'extends',
  'implements',
  'references',
];

const COMMUNITY_KINDS = Object.keys(EDGE_WEIGHTS) as EdgeKind[];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Label propagation over the file graph. Symbols are not part of it: they
 * belong to the community of their file (look it up by `node.filePath`).
 */
export function computeCommunities(
  db: GraphQueries,
  opts: CommunityOptions = {},
): CommunityResult {
  const maxIterations = opts.maxIterations ?? 20;
  const paths = [...new Set(db.filePaths())].sort(compare);
  const n = paths.length;
  const indexOf = new Map<string, number>();
  paths.forEach((p, i) => indexOf.set(p, i));

  const fileOfNode = new Map<string, number>();
  for (const s of db.nodeSummaries()) {
    const i = indexOf.get(s.filePath);
    if (i !== undefined) fileOfNode.set(s.id, i);
  }

  const pairs = new Map<number, number>();
  for (const e of db.edgesOfKinds(COMMUNITY_KINDS)) {
    const a = fileOfNode.get(e.source);
    const b = fileOfNode.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * n + hi;
    pairs.set(key, (pairs.get(key) ?? 0) + (EDGE_WEIGHTS[e.kind] ?? 1));
  }

  const adjacency: { to: number; w: number }[][] = Array.from(
    { length: n },
    () => [],
  );
  for (const [key, w] of pairs) {
    const lo = Math.floor(key / n);
    const hi = key - lo * n;
    (adjacency[lo] as { to: number; w: number }[]).push({ to: hi, w });
    (adjacency[hi] as { to: number; w: number }[]).push({ to: lo, w });
  }

  const labels = Int32Array.from({ length: n }, (_, i) => i);
  const rand = mulberry32(opts.seed ?? 1);
  const order = Array.from({ length: n }, (_, i) => i);
  const sums = new Map<number, number>();

  for (let iter = 0; iter < maxIterations; iter++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = order[i] as number;
      order[i] = order[j] as number;
      order[j] = tmp;
    }
    let changed = false;
    for (const node of order) {
      const neighbours = adjacency[node] as { to: number; w: number }[];
      if (neighbours.length === 0) continue;
      sums.clear();
      for (const { to, w } of neighbours) {
        const l = labels[to] as number;
        sums.set(l, (sums.get(l) ?? 0) + w);
      }
      let best = labels[node] as number;
      let bestW = -1;
      for (const [l, w] of sums) {
        if (w > bestW || (w === bestW && l < best)) {
          best = l;
          bestW = w;
        }
      }
      if (best !== labels[node]) {
        labels[node] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const sizes = new Map<number, { size: number; first: number }>();
  for (let i = 0; i < n; i++) {
    const l = labels[i] as number;
    const g = sizes.get(l);
    if (g) g.size++;
    else sizes.set(l, { size: 1, first: i });
  }
  const ranked = [...sizes.entries()].sort(
    (x, y) => y[1].size - x[1].size || x[1].first - y[1].first,
  );
  const renumber = new Map<number, number>();
  ranked.forEach(([l], idx) => renumber.set(l, idx));

  const assignments = new Map<string, number>();
  for (let i = 0; i < n; i++)
    assignments.set(
      paths[i] as string,
      renumber.get(labels[i] as number) as number,
    );
  return { assignments, count: ranked.length };
}

/** Weighted in+out degree over symbols; files, tests and generated code are skipped. */
export function findHubs(db: GraphQueries, opts: { top?: number } = {}): Hub[] {
  const top = opts.top ?? 20;
  const excluded = db.excludedFilePaths();
  const eligible = new Map<string, string>();
  for (const s of db.nodeSummaries()) {
    if (s.kind === 'file' || excluded.has(s.filePath)) continue;
    eligible.set(s.id, s.qualifiedName);
  }

  const degree = new Map<string, number>();
  for (const e of db.edgesOfKinds(HUB_KINDS)) {
    if (e.source === e.target) continue;
    const w = EDGE_WEIGHTS[e.kind] ?? 1;
    if (eligible.has(e.source))
      degree.set(e.source, (degree.get(e.source) ?? 0) + w);
    if (eligible.has(e.target))
      degree.set(e.target, (degree.get(e.target) ?? 0) + w);
  }

  const rows = [...degree.entries()].sort(
    (a, b) =>
      b[1] - a[1] ||
      compare(eligible.get(a[0]) as string, eligible.get(b[0]) as string) ||
      compare(a[0], b[0]),
  );
  const max = rows[0]?.[1] ?? 0;
  return rows
    .slice(0, Math.max(0, top))
    .map(([nodeId, d]) => ({
      nodeId,
      degree: d,
      score: max > 0 ? d / max : 0,
    }));
}

/** `assignments` is keyed by root-relative `/` file path. Safe inside an open transaction. */
export function persistCommunities(
  db: GraphQueries,
  assignments: Map<string, number>,
): void {
  const obj: Record<string, number> = {};
  for (const [p, id] of assignments) obj[p] = id;
  db.setMeta(COMMUNITIES_KEY, JSON.stringify(obj));
  db.setMeta(COUNT_KEY, String(new Set(assignments.values()).size));
}

export function readCommunities(db: GraphQueries): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const raw = db.getMeta(COMMUNITIES_KEY);
    if (raw === undefined) return out;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return new Map();
    for (const [p, id] of Object.entries(parsed)) {
      if (typeof id !== 'number' || !Number.isInteger(id)) return new Map();
      out.set(p, id);
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Like communities, the persisted hubs are hints from the last full index: an
 * incremental sync leaves them as they are. Safe inside an open transaction.
 */
export function persistHubs(db: GraphQueries, hubs: Hub[]): void {
  db.setMeta(HUBS_KEY, JSON.stringify(hubs.map((h) => ({ nodeId: h.nodeId, degree: h.degree, score: h.score }))));
}

function isHub(v: unknown): v is Hub {
  if (typeof v !== 'object' || v === null) return false;
  const h = v as Record<string, unknown>;
  return typeof h['nodeId'] === 'string' && Number.isFinite(h['degree']) && Number.isFinite(h['score']);
}

/** Ranked hubs of the last full index; empty when absent or corrupt. */
export function readHubs(db: GraphQueries): Hub[] {
  try {
    const raw = db.getMeta(HUBS_KEY);
    if (raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isHub)) return [];
    return parsed.map((h) => ({ nodeId: h.nodeId, degree: h.degree, score: h.score }));
  } catch {
    return [];
  }
}
