import type { GraphOverviewNode, GraphViewEdge } from '../../../../../shared/domain/code-graph';
import type { GraphFilters, GraphRenderer, GraphViewport } from '../services/graph-renderer';
import type { ViewNode } from '../services/graph-view.store';

type Call = [method: string, ...args: unknown[]];

/** In-memory GraphRenderer for component specs: records calls and lets the test fire the events. */
export class FakeGraphRenderer implements GraphRenderer {
  readonly calls: Call[] = [];
  mounted: HTMLElement | null = null;
  destroyed = false;

  private readonly selectListeners = new Set<(id: string | null) => void>();
  private readonly expandListeners = new Set<(id: string) => void>();
  private readonly moreListeners = new Set<(parentId: string | null, offset: number) => void>();
  private readonly viewportListeners = new Set<(v: GraphViewport) => void>();

  mount(el: HTMLElement): void {
    this.mounted = el;
    this.calls.push(['mount', el]);
  }

  setElements(nodes: readonly ViewNode[], edges: readonly GraphViewEdge[]): Promise<void> {
    this.calls.push(['setElements', nodes, edges]);
    return Promise.resolve();
  }

  addNodes(parentId: string | null, nodes: readonly ViewNode[], edges: readonly GraphViewEdge[]): Promise<void> {
    this.calls.push(['addNodes', parentId, nodes, edges]);
    return Promise.resolve();
  }

  removeNode(id: string): void {
    this.calls.push(['removeNode', id]);
  }

  explode(parentId: string, nodes: readonly ViewNode[], edges: readonly GraphViewEdge[]): Promise<void> {
    this.calls.push(['explode', parentId, nodes, edges]);
    return Promise.resolve();
  }

  collapse(id: string, childIds: readonly string[], restoredEdges: readonly GraphViewEdge[], node?: GraphOverviewNode): void {
    this.calls.push(['collapse', id, childIds, restoredEdges, node]);
  }

  select(id: string | null): void {
    this.calls.push(['select', id]);
  }

  focus(id: string): void {
    this.calls.push(['focus', id]);
  }

  setFilters(filters: GraphFilters): void {
    this.calls.push(['setFilters', filters]);
  }

  fit(): void {
    this.calls.push(['fit']);
  }

  zoomBy(factor: number): void {
    this.calls.push(['zoomBy', factor]);
  }

  resize(): void {
    this.calls.push(['resize']);
  }

  refreshTheme(): void {
    this.calls.push(['refreshTheme']);
  }

  destroy(): void {
    this.destroyed = true;
    this.calls.push(['destroy']);
    this.selectListeners.clear();
    this.expandListeners.clear();
    this.moreListeners.clear();
    this.viewportListeners.clear();
  }

  onSelect(cb: (id: string | null) => void): () => void {
    return subscribe(this.selectListeners, cb);
  }

  onExpandRequest(cb: (id: string) => void): () => void {
    return subscribe(this.expandListeners, cb);
  }

  onShowMore(cb: (parentId: string | null, offset: number) => void): () => void {
    return subscribe(this.moreListeners, cb);
  }

  onViewportChange(cb: (v: GraphViewport) => void): () => void {
    return subscribe(this.viewportListeners, cb);
  }

  emitSelect(id: string | null): void {
    for (const cb of this.selectListeners) cb(id);
  }

  emitExpandRequest(id: string): void {
    for (const cb of this.expandListeners) cb(id);
  }

  emitShowMore(parentId: string | null, offset: number): void {
    for (const cb of this.moreListeners) cb(parentId, offset);
  }

  emitViewport(v: GraphViewport): void {
    for (const cb of this.viewportListeners) cb(v);
  }

  callsOf(method: string): Call[] {
    return this.calls.filter((c) => c[0] === method);
  }
}

function subscribe<T>(set: Set<T>, cb: T): () => void {
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}
