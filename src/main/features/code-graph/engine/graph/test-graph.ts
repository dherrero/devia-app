import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
