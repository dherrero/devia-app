import { Injectable, inject, signal } from '@angular/core';

import {
  GRAPH_EXPAND_LIMIT, type GraphOverviewNode, type GraphViewEdge, type GraphViewPage,
} from '../../../../../shared/domain/code-graph';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { pluralKey } from '../utils/plural';

/** Hard cap of nodes on screen (spike T-479 measured ~97 fps at 8.8k elements; edges come on top). */
export const VISIBLE_NODE_CAP = 5000;
/** The most `visibleIds` an expand request may carry (contract T-503). */
export const VISIBLE_IDS_LIMIT = 2000;

const COLLAPSED_NOTICE = 'codeGraph.canvas.collapsed_notice';

/** Placeholder for the rest of a paged level; activating it calls `showMore(parentId, offset)`. */
export interface MoreNode {
  id: string;
  kind: 'more';
  /** Absent for the root level. */
  parentId?: string;
  offset: number;
  remaining: number;
}

export type ViewNode = GraphOverviewNode | MoreNode;

export interface GraphViewNotice {
  key: string;
  params: Record<string, number>;
}

/** Deltas for a renderer, emitted synchronously after each state change. */
export type GraphViewChange =
  | { type: 'reset'; nodes: readonly ViewNode[]; edges: readonly GraphViewEdge[] }
  | {
    type: 'explode';
    parentId: string;
    parent: GraphOverviewNode;
    nodes: readonly ViewNode[];
    edges: readonly GraphViewEdge[];
  }
  | {
    type: 'collapse';
    id: string;
    node: GraphOverviewNode;
    removedIds: readonly string[];
    restoredEdges: readonly GraphViewEdge[];
  }
  | {
    type: 'append';
    parentId: string | null;
    removedId: string;
    nodes: readonly ViewNode[];
    edges: readonly GraphViewEdge[];
  };

export function isMoreNode(node: ViewNode): node is MoreNode {
  return node.kind === 'more';
}

export function moreNodeId(parentId: string | null, offset: number): string {
  return `more:${parentId ?? ''}:${offset}`;
}

export function edgeId(edge: GraphViewEdge): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.kind}`;
}

interface StoredEdge {
  edge: GraphViewEdge;
  seq: number;
}

interface Expansion {
  node: GraphOverviewNode;
  /** Direct children on screen (more nodes included); nested expansions hang off their own record. */
  children: Set<string>;
  /** The parent's edges at explode time, with their sequence numbers, to restore them verbatim. */
  savedEdges: StoredEdge[];
  lastUsed: number;
}

/**
 * View model of the code graph canvas (S-44 T-510): which nodes and aggregated
 * edges are on screen while the user explodes directories into files and files
 * into symbols.
 *
 * Explode replaces the parent by its children (the parent leaves the screen).
 * Collapse strategy: each expansion keeps the parent node and the edges it had
 * when it exploded (with their sequence numbers). Collapsing removes the whole
 * subtree (nested expansions included) and every edge touching it, then
 *  1. restores the saved parent edges whose other end is still on screen,
 *     verbatim and in their original order, and
 *  2. folds the removed edges that crossed from the subtree to a node that was
 *     NOT on screen at explode time (a node revealed later, e.g. by exploding a
 *     neighbour) back onto the parent, summing weights as `aggregate` edges.
 * Collapsing in reverse order is therefore exact; an out-of-order collapse
 * yields the same nodes and the server's aggregation (sums of the folded
 * edges) unless an edge page was truncated.
 *
 * Async results are dropped when the project changed (generation token) or the
 * node they belong to left the screen meanwhile.
 */
@Injectable()
export class GraphViewStore {
  private readonly api = inject(ElectronApiService);

  private readonly _nodes = signal<readonly ViewNode[]>([]);
  private readonly _edges = signal<readonly GraphViewEdge[]>([]);
  private readonly _selectedId = signal<string | null>(null);
  private readonly _expanded = signal<ReadonlySet<string>>(new Set());
  private readonly _visibleCount = signal(0);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _notice = signal<GraphViewNotice | null>(null);
  private readonly _edgesTruncated = signal(false);
  private readonly _empty = signal(false);

  readonly nodes = this._nodes.asReadonly();
  readonly edges = this._edges.asReadonly();
  readonly selectedId = this._selectedId.asReadonly();
  readonly expanded = this._expanded.asReadonly();
  readonly visibleCount = this._visibleCount.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly notice = this._notice.asReadonly();
  readonly edgesTruncated = this._edgesTruncated.asReadonly();
  readonly empty = this._empty.asReadonly();

  private project: string | null = null;
  /** The graph revision last requested through show() (opaque: changes when the graph on disk changed). */
  private revision: string | number | undefined = undefined;
  private generation = 0;
  private seq = 0;
  private clock = 0;
  private nodeMap = new Map<string, ViewNode>();
  private edgeMap = new Map<string, StoredEdge>();
  private expansions = new Map<string, Expansion>();
  /** Child id → the expanded node it came from. */
  private parentOf = new Map<string, string>();
  private inflight = new Map<string, Promise<void>>();
  private pendingLoad: Promise<void> | null = null;
  private listeners = new Set<(change: GraphViewChange) => void>();

  onChange(cb: (change: GraphViewChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Shows `project` as of `revision`: a no-op when it is already shown (or
   * loading), a reload that keeps the view when only the revision changed, a
   * fresh load otherwise. A failed load is retried.
   */
  show(project: string, revision?: string | number): Promise<void> {
    if (this.project === project && this.revision === revision && this._error() === null) {
      return this.pendingLoad ?? Promise.resolve();
    }
    const keepView = this.project === project && this.nodeMap.size > 0;
    const run = keepView ? this.reload(project) : this.loadOverview(project);
    this.revision = revision;
    const pending = run.finally(() => {
      if (this.pendingLoad === pending) this.pendingLoad = null;
    });
    this.pendingLoad = pending;
    return pending;
  }

  async loadOverview(project: string): Promise<void> {
    this.clear();
    this.project = project;
    const token = this.generation;
    this._loading.set(true);
    try {
      const page = await this.api.codeGraphOverview(project);
      if (token !== this.generation) return;
      const nodes: ViewNode[] = [...page.nodes];
      const more = this.moreFor(null, page.nodes.length, page);
      if (more) nodes.push(more);
      for (const node of nodes) this.nodeMap.set(node.id, node);
      for (const edge of page.edges) this.addEdge(edge);
      this._empty.set(page.nodes.length === 0);
      this._edgesTruncated.set(page.edgesTruncated === true);
      this.publish();
      this.emit({ type: 'reset', nodes: this._nodes(), edges: this._edges() });
    } catch (err) {
      if (token === this.generation) this._error.set(messageOf(err));
    } finally {
      if (token === this.generation) this._loading.set(false);
    }
  }

  expand(id: string): Promise<void> {
    const existing = this.expansions.get(id);
    if (existing) {
      this.touch(id);
      return Promise.resolve();
    }
    return this.once(id, () => this.doExpand(id));
  }

  showMore(parentId: string | null, offset: number): Promise<void> {
    const moreId = moreNodeId(parentId, offset);
    return this.once(moreId, () => this.doShowMore(parentId, offset, moreId));
  }

  collapse(id: string): void {
    if (!this.collapseInternal(id)) return;
    this.publish();
  }

  select(id: string | null): void {
    this._selectedId.set(id);
    if (id !== null) this.touchOwnerOf(id);
  }

  async revealNode(id: string, ancestors: readonly string[]): Promise<void> {
    const token = this.generation;
    for (const ancestor of ancestors) {
      if (token !== this.generation) return;
      if (this.expansions.has(ancestor)) {
        this.touch(ancestor);
        continue;
      }
      if (!this.nodeMap.has(ancestor)) break;
      await this.expand(ancestor);
    }
    if (token !== this.generation) return;
    if (this.nodeMap.has(id)) this.select(id);
  }

  /**
   * Reloads after the graph changed on disk (reindex/update), re-opening the
   * expansions whose nodes still exist (parents before children: map order)
   * and keeping the selection when its node survived.
   */
  async reload(project: string): Promise<void> {
    const selected = this._selectedId();
    const expanded = [...this.expansions.keys()];
    const loading = this.loadOverview(project);
    const token = this.generation;
    await loading;
    for (const id of expanded) {
      if (token !== this.generation) return;
      if (this.nodeMap.has(id) && !this.expansions.has(id)) await this.expand(id);
    }
    if (token !== this.generation) return;
    if (selected !== null && this.nodeMap.has(selected)) this.select(selected);
  }

  /** The expanded node a visible node came from; null for root entries. */
  ownerOf(id: string): string | null {
    return this.parentOf.get(id) ?? null;
  }

  /** The node an expansion replaced (it is off screen while expanded). */
  expandedNode(id: string): GraphOverviewNode | null {
    return this.expansions.get(id)?.node ?? null;
  }

  reset(): void {
    this.revision = undefined;
    this.pendingLoad = null;
    this.clear();
    this.emit({ type: 'reset', nodes: [], edges: [] });
  }

  dismissNotice(): void {
    this._notice.set(null);
  }

  dismissError(): void {
    this._error.set(null);
  }

  private clear(): void {
    this.generation++;
    this.project = null;
    this.nodeMap = new Map();
    this.edgeMap = new Map();
    this.expansions = new Map();
    this.parentOf = new Map();
    this.inflight = new Map();
    this._selectedId.set(null);
    this._loading.set(false);
    this._error.set(null);
    this._notice.set(null);
    this._edgesTruncated.set(false);
    this._empty.set(false);
    this.publish();
  }

  private once(key: string, run: () => Promise<void>): Promise<void> {
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const inflight = this.inflight;
    const promise = run().finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  }

  private async doExpand(id: string): Promise<void> {
    const project = this.project;
    const node = this.nodeMap.get(id);
    if (project === null || !node || isMoreNode(node) || node.childCount <= 0) return;
    const token = this.generation;
    const protect = this.ancestorChain(id);
    this.makeRoom(this.nodeMap.size - 1 + pageSize(node.childCount), protect);
    try {
      const page = await this.api.codeGraphExpand(project, id, { visibleIds: this.relevantVisibleIds(id) });
      if (token !== this.generation || !this.nodeMap.has(id) || this.expansions.has(id)) return;
      if (page.nodes.length === 0) return;
      this.explode(node, page);
      this.makeRoom(this.nodeMap.size, protect);
      this.publish();
    } catch (err) {
      if (token === this.generation) this._error.set(messageOf(err));
    }
  }

  private async doShowMore(parentId: string | null, offset: number, moreId: string): Promise<void> {
    const project = this.project;
    const more = this.nodeMap.get(moreId);
    if (project === null || !more || !isMoreNode(more)) return;
    const token = this.generation;
    const protect = parentId === null ? new Set<string>() : this.ancestorChain(parentId);
    this.makeRoom(this.nodeMap.size - 1 + pageSize(more.remaining), protect);
    try {
      const page = parentId === null
        ? await this.api.codeGraphOverview(project, { offset })
        : await this.api.codeGraphExpand(project, parentId, { offset, visibleIds: this.relevantVisibleIds(null) });
      if (token !== this.generation || !this.nodeMap.has(moreId)) return;
      const expansion = parentId === null ? undefined : this.expansions.get(parentId);
      if (parentId !== null && !expansion) return;

      const added: ViewNode[] = page.nodes.filter((n) => !this.nodeMap.has(n.id));
      const next = this.moreFor(parentId, offset + page.nodes.length, page);
      if (next) added.push(next);
      this.replaceInPlace(new Set([moreId]), added);
      if (expansion && parentId !== null) {
        expansion.children.delete(moreId);
        for (const child of added) {
          expansion.children.add(child.id);
          this.parentOf.set(child.id, parentId);
        }
        this.touch(parentId);
      }
      this.parentOf.delete(moreId);
      const edges = this.addEdges(page.edges);
      if (page.edgesTruncated) this._edgesTruncated.set(true);
      this.emit({ type: 'append', parentId, removedId: moreId, nodes: added, edges });
      this.makeRoom(this.nodeMap.size, protect);
      this.publish();
    } catch (err) {
      if (token === this.generation) this._error.set(messageOf(err));
    }
  }

  private explode(parent: GraphOverviewNode, page: GraphViewPage): void {
    const savedEdges: StoredEdge[] = [];
    for (const [key, stored] of this.edgeMap) {
      if (stored.edge.source === parent.id || stored.edge.target === parent.id) {
        savedEdges.push(stored);
        this.edgeMap.delete(key);
      }
    }
    const children: ViewNode[] = page.nodes.filter((n) => !this.nodeMap.has(n.id) && n.id !== parent.id);
    const more = this.moreFor(parent.id, page.nodes.length, page);
    if (more) children.push(more);
    this.replaceInPlace(new Set([parent.id]), children);
    for (const child of children) this.parentOf.set(child.id, parent.id);
    this.expansions.set(parent.id, {
      node: parent,
      children: new Set(children.map((c) => c.id)),
      savedEdges,
      lastUsed: 0,
    });
    this.touch(parent.id);
    const edges = this.addEdges(page.edges);
    if (page.edgesTruncated) this._edgesTruncated.set(true);
    this.emit({ type: 'explode', parentId: parent.id, parent, nodes: children, edges });
  }

  private collapseInternal(id: string): boolean {
    const expansion = this.expansions.get(id);
    if (!expansion) return false;

    const subtree = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      const exp = this.expansions.get(current);
      if (!exp) continue;
      this.expansions.delete(current);
      for (const child of exp.children) {
        subtree.add(child);
        stack.push(child);
      }
    }

    const crossing: GraphViewEdge[] = [];
    for (const [key, stored] of this.edgeMap) {
      const inSource = subtree.has(stored.edge.source);
      const inTarget = subtree.has(stored.edge.target);
      if (!inSource && !inTarget) continue;
      this.edgeMap.delete(key);
      if (inSource !== inTarget) crossing.push(stored.edge);
    }

    this.replaceInPlace(subtree, [expansion.node]);
    for (const child of subtree) this.parentOf.delete(child);

    const restored: GraphViewEdge[] = [];
    const restoredEnds = new Set<string>();
    for (const stored of expansion.savedEdges) {
      const other = stored.edge.source === id ? stored.edge.target : stored.edge.source;
      if (!this.nodeMap.has(other)) continue;
      restoredEnds.add(other);
      const key = edgeId(stored.edge);
      if (this.edgeMap.has(key)) continue;
      this.edgeMap.set(key, stored);
      restored.push(stored.edge);
    }

    const folded = new Map<string, GraphViewEdge>();
    for (const edge of crossing) {
      const source = subtree.has(edge.source) ? id : edge.source;
      const target = subtree.has(edge.target) ? id : edge.target;
      const outside = source === id ? target : source;
      if (restoredEnds.has(outside) || !this.nodeMap.has(outside)) continue;
      const key = `${source}\u0000${target}`;
      const acc = folded.get(key);
      if (acc) acc.weight += edge.weight;
      else folded.set(key, { source, target, kind: 'aggregate', weight: edge.weight });
    }
    for (const edge of folded.values()) {
      if (this.addEdge(edge)) restored.push(edge);
    }

    const selected = this._selectedId();
    if (selected !== null && subtree.has(selected)) this._selectedId.set(id);

    this.emit({ type: 'collapse', id, node: expansion.node, removedIds: [...subtree], restoredEdges: restored });
    return true;
  }

  /** Collapses the least recently used expansions (never `protect`) until `projected` fits the cap. */
  private makeRoom(projected: number, protect: ReadonlySet<string>): void {
    let excess = projected - VISIBLE_NODE_CAP;
    let collapsed = 0;
    while (excess > 0) {
      let victim: string | null = null;
      let oldest = Infinity;
      for (const [id, exp] of this.expansions) {
        if (protect.has(id) || exp.lastUsed >= oldest) continue;
        oldest = exp.lastUsed;
        victim = id;
      }
      if (victim === null) break;
      const before = this.nodeMap.size;
      this.collapseInternal(victim);
      excess -= before - this.nodeMap.size;
      collapsed++;
    }
    if (collapsed > 0) {
      this._notice.set({ key: pluralKey(COLLAPSED_NOTICE, collapsed), params: { count: collapsed } });
      this.publish();
    }
  }

  /**
   * Every visible real node when they fit; otherwise the most relevant ones:
   * the selection, hubs, root entries, then the children of the most recently
   * used expansions (the oldest expansions are the first left out).
   */
  private relevantVisibleIds(exclude: string | null): string[] {
    const candidates: GraphOverviewNode[] = [];
    for (const node of this.nodeMap.values()) {
      if (!isMoreNode(node) && node.id !== exclude) candidates.push(node);
    }
    if (candidates.length <= VISIBLE_IDS_LIMIT) return candidates.map((n) => n.id);

    const selected = this._selectedId();
    const rank = (node: GraphOverviewNode): number => {
      if (node.id === selected) return Number.MAX_SAFE_INTEGER;
      if (node.hub) return Number.MAX_SAFE_INTEGER - 1;
      const owner = this.parentOf.get(node.id);
      if (owner === undefined) return Number.MAX_SAFE_INTEGER - 2;
      return this.expansions.get(owner)?.lastUsed ?? 0;
    };
    return candidates
      .map((node, index) => ({ id: node.id, rank: rank(node), index }))
      .sort((a, b) => b.rank - a.rank || a.index - b.index)
      .slice(0, VISIBLE_IDS_LIMIT)
      .map((c) => c.id);
  }

  private ancestorChain(id: string): Set<string> {
    const chain = new Set<string>([id]);
    let current = this.parentOf.get(id);
    while (current !== undefined && !chain.has(current)) {
      chain.add(current);
      current = this.parentOf.get(current);
    }
    return chain;
  }

  /** Marks an expansion (and the ones above it) as just used, for the LRU. */
  private touch(id: string): void {
    const tick = ++this.clock;
    for (const ancestor of this.ancestorChain(id)) {
      const exp = this.expansions.get(ancestor);
      if (exp) exp.lastUsed = tick;
    }
  }

  private touchOwnerOf(id: string): void {
    const owner = this.parentOf.get(id);
    if (owner !== undefined) this.touch(owner);
  }

  /** Swaps `remove` for `insert` at the position of the first removed node, keeping the rest in order. */
  private replaceInPlace(remove: ReadonlySet<string>, insert: readonly ViewNode[]): void {
    const next = new Map<string, ViewNode>();
    let inserted = false;
    for (const [id, node] of this.nodeMap) {
      if (remove.has(id)) {
        if (!inserted) {
          for (const n of insert) next.set(n.id, n);
          inserted = true;
        }
        continue;
      }
      next.set(id, node);
    }
    if (!inserted) for (const n of insert) next.set(n.id, n);
    this.nodeMap = next;
  }

  private addEdges(edges: readonly GraphViewEdge[]): GraphViewEdge[] {
    const added: GraphViewEdge[] = [];
    for (const edge of edges) if (this.addEdge(edge)) added.push(edge);
    return added;
  }

  private addEdge(edge: GraphViewEdge): boolean {
    if (edge.source === edge.target) return false;
    const source = this.nodeMap.get(edge.source);
    const target = this.nodeMap.get(edge.target);
    if (!source || !target || isMoreNode(source) || isMoreNode(target)) return false;
    const key = edgeId(edge);
    if (this.edgeMap.has(key)) return false;
    this.edgeMap.set(key, { edge, seq: this.seq++ });
    return true;
  }

  private moreFor(parentId: string | null, nextOffset: number, page: GraphViewPage): MoreNode | null {
    if (!page.hasMore) return null;
    const more: MoreNode = {
      id: moreNodeId(parentId, nextOffset),
      kind: 'more',
      offset: nextOffset,
      remaining: Math.max(0, page.total - nextOffset),
    };
    if (parentId !== null) more.parentId = parentId;
    return more;
  }

  private publish(): void {
    const edges = [...this.edgeMap.values()].sort((a, b) => a.seq - b.seq).map((s) => s.edge);
    this._nodes.set([...this.nodeMap.values()]);
    this._edges.set(edges);
    this._expanded.set(new Set(this.expansions.keys()));
    this._visibleCount.set(this.nodeMap.size);
  }

  private emit(change: GraphViewChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }
}

/** Nodes a page for `count` children adds: at most one page plus its "more" node. */
function pageSize(count: number): number {
  return count > GRAPH_EXPAND_LIMIT ? GRAPH_EXPAND_LIMIT + 1 : Math.max(0, count);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
