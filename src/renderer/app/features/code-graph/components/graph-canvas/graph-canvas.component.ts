import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, signal,
  untracked, viewChild,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AlertComponent, ButtonComponent, IconComponent, SpinnerComponent } from '@devia/ui';
import { LucideMaximize, LucideRotateCcw, LucideX, LucideZoomIn, LucideZoomOut } from '@lucide/angular';

import type { GraphOverviewNode } from '../../../../../../shared/domain/code-graph';
import { GRAPH_RENDERER_FACTORY, type GraphRenderer } from '../../services/graph-renderer';
import { GraphViewStore, isMoreNode, type GraphViewChange, type ViewNode } from '../../services/graph-view.store';
import { describeCodeGraphError } from '../../utils/code-graph-error';
import { COMMUNITY_PALETTE, shapeLegend } from '../../utils/graph-style';
import { pluralKey } from '../../utils/plural';

const ZOOM_STEP = 1.25;
const PAN_STEP = 80;
const LEGEND_SWATCHES = COMMUNITY_PALETTE.slice(0, 6);
const LEGEND_SHAPES = shapeLegend().map((entry) => ({
  shape: entry.shape,
  label: entry.kind === null ? 'codeGraph.canvas.legend.symbol' : `codeGraph.canvas.kind.${entry.kind}`,
}));

let nextId = 0;

/**
 * The interactive code graph (S-44 T-510): draws the page-level GraphViewStore
 * through a GraphRenderer (created by GRAPH_RENDERER_FACTORY, Cytoscape in the
 * app, a fake in specs) and maps pointer and keyboard input onto store calls.
 *
 * Keyboard (the surface is focusable, `role="application"`): arrows pan,
 * `+`/`-` zoom, `0` fits, `[`/`]` walk the nodes in display order (select and
 * centre), Enter/Space expand the selected node (or load the next page of a
 * "more" node), Backspace collapses the expansion it came from, Escape clears
 * the selection. Keys with Ctrl/Cmd/Alt are left to the app. A double click
 * never collapses: on a leaf it is too easy to fire by accident.
 */
@Component({
  selector: 'ds-graph-canvas',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, ButtonComponent, IconComponent, SpinnerComponent, TranslateModule],
  templateUrl: './graph-canvas.component.html',
  styleUrl: './graph-canvas.component.scss',
})
export class GraphCanvasComponent {
  readonly store = inject(GraphViewStore);
  private readonly factory = inject(GRAPH_RENDERER_FACTORY);
  private readonly translate = inject(TranslateService);

  readonly project = input.required<string>();
  /** Changes when the graph on disk changed: reloads, keeping expansions and selection. */
  readonly revision = input<string | number | undefined>(undefined);

  private readonly surface = viewChild.required<ElementRef<HTMLElement>>('surface');

  readonly helpId = `cg-canvas-help-${nextId++}`;
  readonly LucideZoomIn = LucideZoomIn;
  readonly LucideZoomOut = LucideZoomOut;
  readonly LucideMaximize = LucideMaximize;
  readonly LucideRotateCcw = LucideRotateCcw;
  readonly LucideX = LucideX;
  readonly swatches = LEGEND_SWATCHES;
  readonly shapes = LEGEND_SHAPES;

  private renderer: GraphRenderer | null = null;
  private destroyed = false;
  private readonly cleanups: (() => void)[] = [];

  readonly ready = signal(false);
  readonly announcement = signal('');
  private readonly pending = signal(0);
  readonly busy = computed(() => this.pending() > 0);

  readonly nodeById = computed(() => new Map(this.store.nodes().map((node) => [node.id, node])));
  readonly selected = computed<ViewNode | null>(() => {
    const id = this.store.selectedId();
    return id === null ? null : (this.nodeById().get(id) ?? null);
  });
  readonly selectedNode = computed<GraphOverviewNode | null>(() => {
    const node = this.selected();
    return node && !isMoreNode(node) ? node : null;
  });
  readonly selectionOwner = computed<GraphOverviewNode | null>(() => {
    const node = this.selectedNode();
    // ownerOf() is not a signal: the expanded set changes whenever ownership does.
    this.store.expanded();
    const ownerId = node ? this.store.ownerOf(node.id) : null;
    return ownerId === null ? null : this.store.expandedNode(ownerId);
  });

  readonly hasGraph = computed(() => this.store.nodes().length > 0);
  readonly loadFailed = computed(() => this.store.error() !== null && !this.hasGraph());
  readonly actionError = computed(() => (this.hasGraph() ? describeCodeGraphError(this.store.error()) : null));
  readonly showSkeleton = computed(() => !this.loadFailed() && !this.store.empty() && (!this.hasGraph() || !this.ready()));

  constructor() {
    effect(() => {
      const project = this.project();
      const revision = this.revision();
      untracked(() => void this.store.show(project, revision));
    });
    effect(() => {
      const id = this.store.selectedId();
      untracked(() => this.renderer?.select(id));
    });
    afterNextRender(() => void this.init());
    inject(DestroyRef).onDestroy(() => this.teardown());
  }

  countKey(count: number): string {
    return pluralKey('codeGraph.canvas.count', count);
  }

  childrenKey(count: number): string {
    return pluralKey('codeGraph.canvas.children', count);
  }

  kindLabel(kind: string): string {
    return this.translate.instant(`codeGraph.canvas.kind.${kind}`) as string;
  }

  zoomIn(): void {
    this.renderer?.zoomBy(ZOOM_STEP);
  }

  zoomOut(): void {
    this.renderer?.zoomBy(1 / ZOOM_STEP);
  }

  fit(): void {
    this.renderer?.fit();
  }

  describeLoadError(raw: string): string | null {
    return describeCodeGraphError(raw)?.detail ?? null;
  }

  retry(): void {
    void this.store.reload(this.project());
  }

  expandSelected(): boolean {
    const node = this.selected();
    return node ? this.activate(node.id) : false;
  }

  collapseSelectionOwner(): void {
    const id = this.store.selectedId();
    const owner = id === null ? null : this.store.ownerOf(id);
    if (owner !== null) this.store.collapse(owner);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!this.handleKey(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  private handleKey(key: string): boolean {
    switch (key) {
      case '+': case '=': this.zoomIn(); return true;
      case '-': case '_': this.zoomOut(); return true;
      case '0': this.fit(); return true;
      case 'ArrowLeft': this.renderer?.panBy(PAN_STEP, 0); return true;
      case 'ArrowRight': this.renderer?.panBy(-PAN_STEP, 0); return true;
      case 'ArrowUp': this.renderer?.panBy(0, PAN_STEP); return true;
      case 'ArrowDown': this.renderer?.panBy(0, -PAN_STEP); return true;
      case ']': this.step(1); return true;
      case '[': this.step(-1); return true;
      case 'Escape':
        if (this.store.selectedId() === null) return false;
        this.store.select(null);
        return true;
      case 'Enter': case ' ':
        return this.expandSelected();
      case 'Backspace':
        this.collapseSelectionOwner();
        return true;
      default:
        return false;
    }
  }

  private step(direction: 1 | -1): void {
    const nodes = this.store.nodes();
    if (nodes.length === 0) return;
    const current = this.store.selectedId();
    const index = current === null ? -1 : nodes.findIndex((node) => node.id === current);
    const next = index < 0
      ? (direction === 1 ? 0 : nodes.length - 1)
      : (index + direction + nodes.length) % nodes.length;
    const node = nodes[next];
    if (!node) return;
    this.store.select(node.id);
    this.renderer?.focus(node.id);
    this.announceSelection(node);
  }

  /** Double click, Enter/Space or the selection bar: expand, or load the next page. False when there is nothing to do. */
  private activate(id: string): boolean {
    const node = this.nodeById().get(id);
    if (!node) return false;
    if (isMoreNode(node)) {
      this.track(this.store.showMore(node.parentId ?? null, node.offset));
      return true;
    }
    if (node.childCount <= 0) return false;
    this.track(this.store.expand(id));
    return true;
  }

  private track(work: Promise<void>): void {
    this.pending.update((n) => n + 1);
    void work.finally(() => this.pending.update((n) => n - 1));
  }

  private onRendererSelect(id: string | null): void {
    this.store.select(id);
    const node = id === null ? null : this.nodeById().get(id);
    if (node) this.announceSelection(node);
  }

  private announceSelection(node: ViewNode): void {
    if (isMoreNode(node)) {
      this.announce('codeGraph.canvas.more', { count: node.remaining }, node.remaining);
      return;
    }
    this.announce('codeGraph.canvas.selected', { label: node.label, kind: this.kindLabel(node.kind), path: node.path });
  }

  private announce(key: string, params: Record<string, unknown>, count?: number): void {
    const resolved = count === undefined ? key : pluralKey(key, count);
    const text = this.translate.instant(resolved, params) as string;
    // A live region only speaks when its text changes: toggle a trailing no-break space so a
    // repeated message (the second "Grafo actualizado") is announced again.
    this.announcement.set(text === this.announcement() ? `${text}\u00A0` : text);
  }

  private apply(change: GraphViewChange): void {
    const renderer = this.renderer;
    if (!renderer) return;
    switch (change.type) {
      case 'reset':
        void renderer.setElements(change.nodes, change.edges);
        renderer.select(this.store.selectedId());
        return;
      case 'reload':
        void renderer.setElements(change.nodes, change.edges, { preserve: true });
        renderer.select(this.store.selectedId());
        this.announce('codeGraph.canvas.updated', {});
        return;
      case 'explode': {
        void renderer.explode(change.parentId, change.nodes, change.edges);
        const count = change.nodes.filter((node) => !isMoreNode(node)).length;
        this.announce('codeGraph.canvas.expanded', { label: change.parent.label, count }, count);
        if (this.store.selectedId() === change.parentId) this.store.select(null);
        return;
      }
      case 'collapse':
        renderer.collapse(change.id, change.removedIds, change.restoredEdges, change.node);
        this.announce('codeGraph.canvas.collapsed', { label: change.node.label });
        renderer.select(this.store.selectedId());
        return;
      case 'append': {
        renderer.removeNode(change.removedId);
        void renderer.addNodes(change.parentId, change.nodes, change.edges);
        const count = change.nodes.filter((node) => !isMoreNode(node)).length;
        this.announce('codeGraph.canvas.more_loaded', { count }, count);
        return;
      }
    }
  }

  private async init(): Promise<void> {
    const renderer = await this.factory({
      reducedMotion: prefersReducedMotion(),
      moreLabel: (count) => this.translate.instant(pluralKey('codeGraph.canvas.more', count), { count }) as string,
    });
    if (this.destroyed) {
      renderer.destroy();
      return;
    }
    const surface = this.surface().nativeElement;
    this.renderer = renderer;
    renderer.mount(surface);
    this.cleanups.push(
      renderer.onSelect((id) => this.onRendererSelect(id)),
      renderer.onExpandRequest((id) => void this.activate(id)),
      renderer.onShowMore((parentId, offset) => this.track(this.store.showMore(parentId, offset))),
      this.store.onChange((change) => this.apply(change)),
    );
    this.observe(surface, renderer);
    if (this.hasGraph()) {
      void renderer.setElements(this.store.nodes(), this.store.edges());
      renderer.select(this.store.selectedId());
    }
    this.ready.set(true);
  }

  private observe(surface: HTMLElement, renderer: GraphRenderer): void {
    if (typeof ResizeObserver !== 'undefined') {
      const resize = new ResizeObserver(() => renderer.resize());
      resize.observe(surface);
      this.cleanups.push(() => resize.disconnect());
    }
    if (typeof MutationObserver !== 'undefined') {
      const theme = new MutationObserver(() => renderer.refreshTheme());
      theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      this.cleanups.push(() => theme.disconnect());
    }
  }

  private teardown(): void {
    this.destroyed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.renderer?.destroy();
    this.renderer = null;
  }
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
