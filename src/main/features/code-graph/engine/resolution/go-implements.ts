import * as path from 'node:path';
import type { GraphEdge } from '../../../../../shared/domain/code-graph';
import type { GraphQueries, NodeSummary } from '../db/queries';

/** An interface satisfied by more structs than this is too generic to link (`String()`, `Close()`). */
export const MAX_IMPLEMENTERS_PER_INTERFACE = 50;

/**
 * Go satisfies interfaces structurally, so the extractor cannot emit `implements`. This links a
 * struct to every interface whose method NAMES it covers (pointer and value receivers both
 * count). Signatures are not compared, so a same-named method with other parameters still
 * matches: edges carry `heuristic` provenance. Interfaces with no methods are ignored, and an
 * interface that would link more than {@link MAX_IMPLEMENTERS_PER_INTERFACE} structs is skipped
 * entirely. Embedded interfaces are not expanded. Returns the number of edges created; running
 * it again creates none.
 */
export function inferGoImplements(db: GraphQueries): number {
  const nodes = db.nodeSummaries().filter((n) => n.language === 'go');
  const types = nodes.filter(
    (n) => n.kind === 'class' || n.kind === 'interface',
  );
  if (types.length === 0) return 0;
  const typeIds = new Set(types.map((t) => t.id));
  const parent = new Map<string, string>();
  for (const e of db.edgesOfKinds(['contains']))
    if (typeIds.has(e.source)) parent.set(e.target, e.source);

  const byDirName = new Map<string, NodeSummary[]>();
  for (const t of types) {
    const key = `${path.posix.dirname(t.filePath)}\0${t.name}`;
    byDirName.set(key, [...(byDirName.get(key) ?? []), t]);
  }

  const methodSets = new Map<string, Set<string>>();
  for (const m of nodes) {
    if (m.kind !== 'method') continue;
    let ownerId = parent.get(m.id);
    if (ownerId === undefined) {
      const typeName = m.qualifiedName.slice(
        0,
        Math.max(0, m.qualifiedName.length - m.name.length - 1),
      );
      const hits = byDirName.get(
        `${path.posix.dirname(m.filePath)}\0${typeName}`,
      );
      const [only] = hits ?? [];
      if (hits?.length === 1 && only) ownerId = only.id;
    }
    if (ownerId === undefined) continue;
    let set = methodSets.get(ownerId);
    if (!set) methodSets.set(ownerId, (set = new Set()));
    set.add(m.name);
  }

  const existing = new Set(
    db.edgesOfKinds(['implements']).map((e) => `${e.source}\0${e.target}`),
  );
  const structs = types.filter((t) => t.kind === 'class');
  const edges: GraphEdge[] = [];
  for (const iface of types) {
    if (iface.kind !== 'interface') continue;
    const wanted = methodSets.get(iface.id);
    if (!wanted || wanted.size === 0) continue;
    const implementers = structs.filter((s) => {
      const have = methodSets.get(s.id);
      return have !== undefined && [...wanted].every((m) => have.has(m));
    });
    if (implementers.length > MAX_IMPLEMENTERS_PER_INTERFACE) continue;
    for (const s of implementers)
      if (!existing.has(`${s.id}\0${iface.id}`))
        edges.push({
          source: s.id,
          target: iface.id,
          kind: 'implements',
          provenance: 'heuristic',
        });
  }
  if (edges.length > 0) db.insertEdges(edges);
  return edges.length;
}
