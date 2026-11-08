import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  NodeKind,
} from '../../../../../shared/domain/code-graph';
import { openGraphDb, type GraphDb } from '../db/connection';
import { GraphQueries } from '../db/queries';

export interface SeededDb {
  q: GraphQueries;
  close(): void;
}

export function openTempDb(): SeededDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-graph-'));
  const db: GraphDb = openGraphDb(path.join(dir, 'graph.db'));
  return {
    q: new GraphQueries(db),
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function mkNode(
  id: string,
  extra: Partial<GraphNode> & { kind?: NodeKind } = {},
): GraphNode {
  return {
    id,
    kind: 'function',
    name: id,
    qualifiedName: id,
    filePath: `src/${id}.ts`,
    language: 'typescript',
    startLine: 1,
    endLine: 2,
    isExported: false,
    ...extra,
  };
}

export function mkEdge(
  source: string,
  target: string,
  kind: EdgeKind = 'calls',
): GraphEdge {
  return { source, target, kind };
}

export function seedGraph(
  q: GraphQueries,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const files = new Set(nodes.map((n) => n.filePath));
  for (const p of files) {
    q.upsertFile({
      path: p,
      contentHash: 'h',
      language: 'typescript',
      size: 1,
      modifiedAt: 1,
      indexedAt: 1,
      nodeCount: 0,
      generated: false,
      isTest: false,
    });
  }
  q.insertNodes(nodes);
  q.insertEdges(edges);
}

/** Warm-up run plus the fastest of `runs` timed runs, so a busy machine does not fail a perf bound. */
export function bestOf<T>(fn: () => T, runs = 3): { ms: number; value: T } {
  let value = fn();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    value = fn();
    best = Math.min(best, performance.now() - start);
  }
  return { ms: best, value };
}

/**
 * Idle-machine duration (ms) of {@link calibrationWorkload}, measured as the best of 3 runs on the
 * dev machine (8 cores) outside the test suite: 9.3-9.8 ms across 8 repeated samples, even at load average ~5, so 9.5.
 * It only anchors the ratio: a slower CI box simply reads as "slowed down" and gets a looser budget,
 * which is the intended behaviour, and the clamp keeps the result in [1, MAX_SLOWDOWN].
 */
const REFERENCE_MS = 9.5;
/**
 * A genuine regression is O(n^2) or worse on 20k-200k items, i.e. far more than 12x slower than the
 * idle budget, so capping here keeps such a regression failing even on a heavily loaded machine.
 */
const MAX_SLOWDOWN = 12;

/** Deterministic mix of CPU work and in-memory `node:sqlite` inserts/selects (~9.5 ms when idle). */
function calibrationWorkload(): void {
  let acc = 0;
  for (let i = 1; i < 250_000; i++) acc = (acc + i * i) % 1_000_003;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE c (id INTEGER PRIMARY KEY, v TEXT)');
    const ins = db.prepare('INSERT INTO c (id, v) VALUES (?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < 3000; i++) ins.run(i, `v${i}_${acc}`);
    db.exec('COMMIT');
    db.prepare('SELECT COUNT(*) AS n FROM c WHERE v LIKE ?').get('%9%');
    db.prepare('SELECT v FROM c WHERE id = ?').get(1500);
  } finally {
    db.close();
  }
}

/** Best-of-3 wall time of the calibration workload, in ms. */
export function measureCalibrationMs(): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    calibrationWorkload();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/**
 * Scales an idle-machine time budget by how slow the machine is RIGHT NOW (calibrated at call time,
 * so call it right before the assertion). Never stricter than `idleMs`, never looser than 12x.
 */
export function perfBudget(idleMs: number, calibrate: () => number = measureCalibrationMs): number {
  const slowdown = Math.min(MAX_SLOWDOWN, Math.max(1, calibrate() / REFERENCE_MS));
  return idleMs * slowdown;
}
