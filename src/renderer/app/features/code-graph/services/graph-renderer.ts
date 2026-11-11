import { InjectionToken, NgZone, inject } from '@angular/core';
import type {
  Collection, Core, CytoscapeOptions, ElementDefinition, EventObject, Ext, LayoutOptions, NodeCollection, NodeSingular,
  Position,
  StylesheetJson,
} from 'cytoscape';

import type { GraphOverviewNode, GraphViewEdge } from '../../../../../shared/domain/code-graph';
import {
  BURST_ANIMATION_MS, BURST_GAP, LayoutQueue, MIN_MOVE_PX, burstSpacing, continueSpiral, fitViewport, globalLayoutOptions, planBurst,
  pullBack, pushAway, type RunningLayout,
} from '../utils/graph-layout';
import {
  ADJACENT_EDGE_OPACITY, COMMUNITY_PALETTE, EDGE_COLOR, FADED_EDGE_FACTOR, HOVER_BORDER_WIDTH, HOVER_COLOR, HUB_RING_COLOR,
  HUB_RING_WIDTH, LABEL_COLOR, LABEL_OUTLINE_COLOR, MORE_BORDER_COLOR, MORE_FILL_COLOR, NEUTRAL_COLOR, SELECTED_BORDER_WIDTH,
  SELECTED_COLOR, TEST_OPACITY, edgeOpacity, edgeWidth, graphStyle, refreshTheme as forgetResolvedTheme, resolveStyleVars,
  zoomedLabelSize, type ResolvedStyleVars,
} from '../utils/graph-style';
import { edgeId, isMoreNode, type ViewNode } from './graph-view.store';

export interface GraphFilters {
  hideTests?: boolean;
  hiddenKinds?: ReadonlySet<string>;
  minEdgeWeight?: number;
}

export interface GraphViewport {
  zoom: number;
  pan: Position;
  /** False while zoomed out past the label threshold (only hubs and the selection keep theirs). */
  labels: boolean;
}

export interface SetElementsOptions {
  /**
   * The same graph, rebuilt after a change on disk: surviving nodes keep their
   * position, new ones land next to their parent and the camera stays put. A
   * fresh layout runs only when too little of the old view survives.
   */
  preserve?: boolean;
}

export interface GraphRendererOptions {
  /** `prefers-reduced-motion: reduce`: no layout or camera animations. */
  reducedMotion: boolean;
  /** Label of a "more" node (translated by the caller). */
  moreLabel: (remaining: number) => string;
}

/**
 * The graph drawing surface, kept behind an interface so the store and the
 * canvas component never depend on the drawing library (Cytoscape today).
 * Every `on*` returns its unsubscribe function; callbacks run inside the
 * Angular zone. Calls after `destroy()` are no-ops.
 */
export interface GraphRenderer {
  mount(el: HTMLElement): void;
  /** Replaces everything and runs the global layout (unless `preserve` keeps the old one); resolves when it ends. */
  setElements(nodes: readonly ViewNode[], edges: readonly GraphViewEdge[], options?: SetElementsOptions): Promise<void>;
  /** Adds a page of nodes (a "more" continuation) where the "more" node was, flying them out on a spiral. */
  addNodes(parentId: string | null, nodes: readonly ViewNode[], edges: readonly GraphViewEdge[]): Promise<void>;
  removeNode(id: string): void;
  /** Replaces the parent by its children in place, flying them out on a spiral and pushing the neighbours aside. */
  explode(parentId: string, nodes: readonly ViewNode[], edges: readonly GraphViewEdge[]): Promise<void>;
  /** Removes `childIds` and puts the parent back where they were. `node` is needed only if the renderer never saw it. */
  collapse(id: string, childIds: readonly string[], restoredEdges: readonly GraphViewEdge[], node?: GraphOverviewNode): void;
  select(id: string | null): void;
  /** Centres and zooms on a node. */
  focus(id: string): void;
  setFilters(filters: GraphFilters): void;
  fit(): void;
  zoomBy(factor: number): void;
  /** Moves the view by a rendered (screen) offset. */
  panBy(dx: number, dy: number): void;
  /** Re-measures the container (coalesced to one per frame). */
  resize(): void;
  /** Re-reads the `--dv-*` colours after a theme switch. */
  refreshTheme(): void;
  destroy(): void;
  onSelect(cb: (id: string | null) => void): () => void;
  onExpandRequest(cb: (id: string) => void): () => void;
  onShowMore(cb: (parentId: string | null, offset: number) => void): () => void;
  onViewportChange(cb: (viewport: GraphViewport) => void): () => void;
}

export type GraphRendererFactory = (options: GraphRendererOptions) => Promise<GraphRenderer>;

/** The part of NgZone the renderer needs (tests pass a pass-through). */
export interface ZoneLike {
  run<T>(fn: () => T): T;
  runOutsideAngular<T>(fn: () => T): T;
}

export const GRAPH_RENDERER_FACTORY = new InjectionToken<GraphRendererFactory>('GRAPH_RENDERER_FACTORY', {
  providedIn: 'root',
  factory: () => {
    const zone = inject(NgZone);
    return (options) => createCytoscapeRenderer(zone, options);
  },
});

export { LABEL_ZOOM_THRESHOLD } from '../utils/graph-style';
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const FOCUS_ZOOM = 1.2;
const CAMERA_MS = 300;
const FIT_PADDING = 40;
const VIEWPORT_THROTTLE_MS = 16;
const MORE_NODE_SIZE = 22;
const LABEL_FONT = 10;
/** A reload keeps the old layout when at least this share of the new nodes was already on screen. */
const RELOAD_KEEP_RATIO = 0.3;

type CytoscapeFn = (options?: CytoscapeOptions) => Core;
interface CytoscapeModule {
  (options?: CytoscapeOptions): Core;
  use(ext: Ext): void;
}

let fcoseRegistered = false;

/** Loads Cytoscape and fcose on demand (they stay out of the initial bundle) and registers fcose once. */
export async function createCytoscapeRenderer(
  zone: ZoneLike,
  options: GraphRendererOptions,
  extra: { headless?: boolean } = {},
): Promise<CytoscapeGraphRenderer> {
  const [{ default: cytoscape }, { default: fcose }] = await Promise.all([import('cytoscape'), import('cytoscape-fcose')]);
  const lib = cytoscape as unknown as CytoscapeModule;
  if (!fcoseRegistered) {
    lib.use(fcose);
    fcoseRegistered = true;
  }
  return new CytoscapeGraphRenderer(lib, zone, options, extra.headless === true);
}

export function buildStylesheet(vars: ResolvedStyleVars): StylesheetJson {
  const c = (name: Parameters<ResolvedStyleVars['color']>[0]) => vars.color(name);
  return [
    {
      selector: 'node',
      style: {
        width: 'data(size)',
        height: 'data(size)',
        shape: 'data(shape)' as never,
        'background-color': c(NEUTRAL_COLOR),
        'border-width': 0,
        label: 'data(label)',
        'font-size': LABEL_FONT,
        color: c(LABEL_COLOR),
        'text-valign': 'bottom',
        'text-margin-y': 3,
        'text-outline-color': c(LABEL_OUTLINE_COLOR),
        'text-outline-width': 1,
        'min-zoomed-font-size': 7,
        'text-max-width': '160px',
        'text-wrap': 'ellipsis',
      },
    },
    ...COMMUNITY_PALETTE.map((name, i) => ({ selector: `node.c${i}`, style: { 'background-color': c(name) } })),
    { selector: 'node.hub', style: { 'border-width': HUB_RING_WIDTH, 'border-color': c(HUB_RING_COLOR), 'font-size': 13 } },
    { selector: 'node.test', style: { opacity: TEST_OPACITY } },
    {
      selector: 'node.more',
      style: {
        'background-color': c(MORE_FILL_COLOR),
        'border-width': 1,
        'border-style': 'dashed',
        'border-color': c(MORE_BORDER_COLOR),
        'text-valign': 'center',
        'text-halign': 'right',
        'text-margin-x': 4,
        'text-margin-y': 0,
      },
    },
    { selector: 'node.zo', style: { label: '' } },
    {
      selector: 'node.zo.hub, node.zo.sel',
      style: { label: 'data(label)', 'min-zoomed-font-size': 0, 'font-size': 'data(zfs)' as never, 'text-max-width': '960px' },
    },
    { selector: 'node.hover', style: { 'border-width': HOVER_BORDER_WIDTH, 'border-color': c(HOVER_COLOR) } },
    {
      selector: 'node.sel',
      style: { 'border-width': SELECTED_BORDER_WIDTH, 'border-color': c(SELECTED_COLOR), opacity: 1, 'z-index': 10 },
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'haystack',
        'haystack-radius': 0,
        width: 'data(width)',
        opacity: 'data(opacity)' as never,
        'line-color': c(EDGE_COLOR),
      },
    },
    { selector: 'edge.faded', style: { opacity: FADED_EDGE_FACTOR * 0.5 } },
    { selector: 'edge.adj', style: { 'line-color': c(SELECTED_COLOR), opacity: ADJACENT_EDGE_OPACITY, 'z-index': 5 } },
    { selector: '.filtered', style: { display: 'none' } },
  ];
}

interface MoreData {
  parentId?: string;
  offset: number;
}

/**
 * Cytoscape implementation of GraphRenderer. The only module that loads
 * `cytoscape`/`cytoscape-fcose`. The instance and its event handlers live
 * outside the Angular zone (pan/zoom frames must not trigger change detection);
 * callbacks are re-entered into the zone.
 *
 * Performance settings (spike T-479, 97 fps at 8.8k elements on an M1):
 * texture while panning, pixel ratio capped at 2, haystack edges without arrows,
 * labels hidden below LABEL_ZOOM_THRESHOLD except hubs/selection. Edges stay
 * visible while panning (`hideEdgesOnViewport:false`): the spike measured no
 * fps drop that would justify hiding them.
 */
export class CytoscapeGraphRenderer implements GraphRenderer {
  private cy: Core | null = null;
  private el: HTMLElement | null = null;
  private destroyed = false;
  private zoomedOut = false;
  /** Font size of the labels kept below the zoom threshold (data `zfs` of hubs and the selection). */
  private labelFont = LABEL_FONT;
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private filters: GraphFilters = {};
  private readonly queue = new LayoutQueue();
  private viewportTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeFrame: number | null = null;
  /** Nodes removed by an explode, to put back on collapse. */
  private readonly exploded = new Map<string, GraphOverviewNode>();
  /** Where a removed "more" node sat, keyed by its parent ('' for the root), to seed the next page there. */
  private readonly morePositions = new Map<string, Position>();
  /** Explosions on screen (insertion order): where they burst and how far they pushed the rest, undone on collapse. */
  private readonly bursts = new Map<string, { center: Position; shift: number; reach: number; origin: number }>();

  private readonly selectListeners = new Set<(id: string | null) => void>();
  private readonly expandListeners = new Set<(id: string) => void>();
  private readonly moreListeners = new Set<(parentId: string | null, offset: number) => void>();
  private readonly viewportListeners = new Set<(viewport: GraphViewport) => void>();

  constructor(
    private readonly cytoscape: CytoscapeFn,
    private readonly zone: ZoneLike,
    private readonly options: GraphRendererOptions,
    private readonly headless = false,
  ) {}

  /** The live Cytoscape core, for diagnostics and the headless smoke test. */
  get core(): Core | null {
    return this.cy;
  }

  mount(el: HTMLElement): void {
    if (this.destroyed || this.cy) return;
    this.el = el;
    const base: CytoscapeOptions = {
      style: buildStylesheet(resolveStyleVars(el)),
      styleEnabled: true,
      textureOnViewport: true,
      hideEdgesOnViewport: false,
      motionBlur: false,
      pixelRatio: Math.min(globalThis.devicePixelRatio || 1, 2),
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      boxSelectionEnabled: false,
      autounselectify: true,
    };
    const config: CytoscapeOptions = this.headless ? { ...base, headless: true } : { ...base, container: el };
    this.cy = this.zone.runOutsideAngular(() => this.cytoscape(config));
    this.zone.runOutsideAngular(() => this.bindEvents());
  }

  setElements(nodes: readonly ViewNode[], edges: readonly GraphViewEdge[], options: SetElementsOptions = {}): Promise<void> {
    const cy = this.cy;
    if (!cy) return Promise.resolve();
    if (options.preserve) {
      // Land running animations on their targets: those are the positions the user is about to see.
      cy.nodes().stop(true, true);
      void this.queue.enqueue('reload', settled, { preempt: true });
    }
    const positions = options.preserve ? this.reloadPositions(cy, nodes) : null;
    const ids = new Set(nodes.map((node) => node.id));
    for (const key of [...this.bursts.keys()]) if (!positions || ids.has(key)) this.bursts.delete(key);
    for (const key of [...this.exploded.keys()]) if (!positions || ids.has(key)) this.exploded.delete(key);
    this.morePositions.clear();
    this.selectedId = null;
    this.hoveredId = null;
    cy.batch(() => {
      cy.elements().remove();
      cy.add(nodes.map((node) => {
        const position = positions?.get(node.id);
        return position ? { ...this.nodeElement(node), position } : this.nodeElement(node);
      }));
      cy.add(this.edgeElements(cy, edges));
    });
    if (nodes.length === 0 || positions) return Promise.resolve();
    return this.queue.enqueue('global', () => {
      const running = this.run(cy.elements(), globalLayoutOptions());
      return { stop: running.stop, done: running.done.then(() => this.fitTo(false)) };
    }, { preempt: true });
  }

  /**
   * Where each node goes on a reload: the survivors stay, the new ones join the
   * spiral of their parent's burst (or its old spot, or their siblings), and a
   * node without any of those goes just outside the graph. Null when too few
   * survive for the old layout to mean anything.
   */
  private reloadPositions(cy: Core, nodes: readonly ViewNode[]): Map<string, Position> | null {
    const previous = new Map<string, Position>();
    cy.nodes().forEach((n) => {
      previous.set(n.id(), { ...n.position() });
    });
    const survivors = nodes.filter((node) => previous.has(node.id)).length;
    if (nodes.length === 0 || survivors < nodes.length * RELOAD_KEEP_RATIO) return null;

    const out = new Map<string, Position>();
    const fresh = new Map<string, ViewNode[]>();
    for (const node of nodes) {
      const position = previous.get(node.id);
      if (position) {
        out.set(node.id, position);
        continue;
      }
      const key = node.parentId ?? '';
      fresh.set(key, [...(fresh.get(key) ?? []), node]);
    }
    for (const [key, group] of fresh) {
      const siblings = nodes.filter((node) => (node.parentId ?? '') === key && previous.has(node.id));
      const maxSize = Math.max(...[...group, ...siblings].map((node) => this.sizeOf(node)));
      const anchor = this.reloadAnchor(cy, key, siblings, previous, maxSize);
      continueSpiral(anchor.center, anchor.taken, group.length, maxSize).forEach((position, i) => {
        const node = group[i];
        if (node) out.set(node.id, position);
      });
    }
    return out;
  }

  private reloadAnchor(
    cy: Core,
    parentKey: string,
    siblings: readonly ViewNode[],
    previous: ReadonlyMap<string, Position>,
    maxSize: number,
  ): { center: Position; taken: number } {
    const parentSpot = parentKey === '' ? undefined : previous.get(parentKey);
    if (parentSpot) return { center: parentSpot, taken: 0 };
    const burst = parentKey === '' ? undefined : this.bursts.get(parentKey);
    if (burst) return { center: burst.center, taken: siblings.length };
    const around = siblings.length > 0 ? siblings.map((node) => previous.get(node.id)) : [...previous.values()];
    const points = around.filter((p): p is Position => p !== undefined);
    if (points.length === 0) return { center: this.viewCenter(cy), taken: 0 };
    const x1 = Math.min(...points.map((p) => p.x));
    const x2 = Math.max(...points.map((p) => p.x));
    const y1 = Math.min(...points.map((p) => p.y));
    const y2 = Math.max(...points.map((p) => p.y));
    const radius = Math.hypot(x2 - x1, y2 - y1) / 2 + maxSize;
    return { center: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }, taken: Math.ceil((radius / burstSpacing(maxSize)) ** 2) };
  }

  private sizeOf(node: ViewNode): number {
    return isMoreNode(node) ? MORE_NODE_SIZE : graphStyle(node).size;
  }

  addNodes(parentId: string | null, nodes: readonly ViewNode[], edges: readonly GraphViewEdge[]): Promise<void> {
    const cy = this.cy;
    if (!cy || nodes.length === 0) return Promise.resolve();
    const center = this.morePositions.get(parentId ?? '') ?? this.siblingCenter(cy, parentId) ?? this.viewCenter(cy);
    this.morePositions.delete(parentId ?? '');
    const added = this.addAround(cy, center, nodes, edges);
    return this.burst(`more:${parentId ?? ''}`, null, center, MORE_NODE_SIZE / 2, added);
  }

  removeNode(id: string): void {
    const node = this.cy?.getElementById(id);
    if (!node || node.empty()) return;
    if (node.data('kind') === 'more') {
      const parentId = node.data('parentId') as string | undefined;
      this.morePositions.set(parentId ?? '', { ...node.position() });
    }
    if (this.selectedId === id) this.selectedId = null;
    node.remove();
  }

  explode(parentId: string, nodes: readonly ViewNode[], edges: readonly GraphViewEdge[]): Promise<void> {
    const cy = this.cy;
    if (!cy) return Promise.resolve();
    const parent = cy.getElementById(parentId);
    const center = parent.nonempty() ? { ...parent.position() } : this.viewCenter(cy);
    const parentNode = parent.nonempty() ? (parent.data('node') as GraphOverviewNode | undefined) : undefined;
    const origin = parent.nonempty() ? Number(parent.data('size')) / 2 : 0;
    if (parentNode) this.exploded.set(parentId, parentNode);
    let added: NodeCollection = cy.collection();
    cy.batch(() => {
      added = this.addAround(cy, center, nodes, []);
      parent.remove();
      cy.add(this.edgeElements(cy, edges));
    });
    if (this.selectedId === parentId) this.selectedId = null;
    return this.burst(`explode:${parentId}`, parentId, center, origin, added);
  }

  collapse(id: string, childIds: readonly string[], restoredEdges: readonly GraphViewEdge[], node?: GraphOverviewNode): void {
    const cy = this.cy;
    if (!cy) return;
    const parentNode = node ?? this.exploded.get(id);
    let children = cy.collection();
    for (const childId of childIds) children = children.union(cy.getElementById(childId));
    const box = children.nonempty() ? children.boundingBox() : null;
    const center = this.bursts.get(id)?.center ?? (box ? { x: box.x1 + box.w / 2, y: box.y1 + box.h / 2 } : this.viewCenter(cy));
    cy.batch(() => {
      children.remove();
      if (parentNode && cy.getElementById(id).empty()) cy.add({ ...this.nodeElement(parentNode), position: center });
      cy.add(this.edgeElements(cy, restoredEdges));
    });
    for (const childId of childIds) this.exploded.delete(childId);
    this.exploded.delete(id);
    if (this.selectedId !== null && childIds.includes(this.selectedId)) this.selectedId = null;
    this.closeBursts(id, new Set([id, ...childIds]));
  }

  /** Pulls the neighbours back in, undoing the pushes of the collapsed explosion and of those nested in it (newest first). */
  private closeBursts(id: string, ids: ReadonlySet<string>): void {
    const undo = [...this.bursts].filter(([key]) => ids.has(key)).reverse();
    for (const [key] of undo) this.bursts.delete(key);
    if (!undo.some(([, b]) => b.shift > 0)) return;
    void this.queue.enqueue(`collapse:${id}`, () => {
      const cy = this.cy;
      if (!cy) return settled();
      const targets = new Map<string, Position>();
      cy.nodes().forEach((n) => {
        if (n.id() === id) return;
        const from = n.position();
        let p: Position = { ...from };
        const keep = Number(n.data('size')) / 2;
        for (const [, b] of undo) p = pullBack(b.center, p, b.shift, b.reach, b.origin + keep + BURST_GAP);
        if (moves(from, p)) targets.set(n.id(), p);
      });
      return this.moveTo(cy.nodes().filter((n) => targets.has(n.id())), targets, this.options.reducedMotion);
    });
  }

  select(id: string | null): void {
    const cy = this.cy;
    if (!cy) return;
    this.selectedId = id;
    cy.batch(() => {
      cy.nodes('.sel').removeClass('sel');
      cy.edges('.adj, .faded').removeClass('adj faded');
      if (id === null) return;
      const node = cy.getElementById(id);
      if (node.empty()) return;
      node.data('zfs', this.labelFont);
      node.addClass('sel');
      cy.edges().addClass('faded');
      node.connectedEdges().removeClass('faded').addClass('adj');
    });
  }

  focus(id: string): void {
    const cy = this.cy;
    const node = cy?.getElementById(id);
    if (!cy || !node || node.empty()) return;
    const zoom = Math.max(cy.zoom(), FOCUS_ZOOM);
    if (this.options.reducedMotion) {
      cy.zoom(zoom);
      cy.center(node);
      return;
    }
    this.zone.runOutsideAngular(() => cy.animate({ center: { eles: node }, zoom }, { duration: CAMERA_MS }));
  }

  setFilters(filters: GraphFilters): void {
    const cy = this.cy;
    this.filters = filters;
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        if (this.nodeFiltered(n.data('kind') as string, n.data('test') === true)) n.addClass('filtered');
        else n.removeClass('filtered');
      });
      cy.edges().forEach((edge) => {
        if (this.edgeFiltered(edge.data('weight') as number)) edge.addClass('filtered');
        else edge.removeClass('filtered');
      });
    });
  }

  fit(): void {
    this.fitTo(!this.options.reducedMotion);
  }

  private fitTo(animate: boolean): void {
    const cy = this.cy;
    if (!cy || this.destroyed) return;
    const visible = cy.elements(':visible');
    if (visible.empty()) return;
    const box = visible.boundingBox();
    const viewport = fitViewport(box, { width: cy.width(), height: cy.height() }, FIT_PADDING);
    if (!animate) {
      cy.viewport(viewport);
      return;
    }
    this.zone.runOutsideAngular(() => cy.animate(viewport, { duration: CAMERA_MS }));
  }

  zoomBy(factor: number): void {
    const cy = this.cy;
    if (!cy || !(factor > 0)) return;
    const level = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cy.zoom() * factor));
    cy.zoom({ level, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }

  panBy(dx: number, dy: number): void {
    this.cy?.panBy({ x: dx, y: dy });
  }

  resize(): void {
    if (this.resizeFrame !== null || this.destroyed || !this.cy) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      this.cy?.resize();
    });
  }

  refreshTheme(): void {
    const cy = this.cy;
    if (!cy || !this.el) return;
    forgetResolvedTheme();
    const sheet = buildStylesheet(resolveStyleVars(this.el));
    this.zone.runOutsideAngular(() => cy.style().fromJson(sheet).update());
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.queue.dispose();
    if (this.viewportTimer !== null) clearTimeout(this.viewportTimer);
    this.viewportTimer = null;
    if (this.resizeFrame !== null) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = null;
    this.selectListeners.clear();
    this.expandListeners.clear();
    this.moreListeners.clear();
    this.viewportListeners.clear();
    this.exploded.clear();
    this.morePositions.clear();
    this.bursts.clear();
    const cy = this.cy;
    this.cy = null;
    this.el = null;
    cy?.destroy();
  }

  onSelect(cb: (id: string | null) => void): () => void {
    return this.subscribe(this.selectListeners, cb);
  }

  onExpandRequest(cb: (id: string) => void): () => void {
    return this.subscribe(this.expandListeners, cb);
  }

  onShowMore(cb: (parentId: string | null, offset: number) => void): () => void {
    return this.subscribe(this.moreListeners, cb);
  }

  onViewportChange(cb: (viewport: GraphViewport) => void): () => void {
    return this.subscribe(this.viewportListeners, cb);
  }

  private subscribe<T>(set: Set<T>, cb: T): () => void {
    if (this.destroyed) return () => undefined;
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  private bindEvents(): void {
    const cy = this.cy;
    if (!cy) return;
    cy.on('tap', 'node', (evt: EventObject) => {
      const node = evt.target as NodeSingular;
      if (node.data('kind') === 'more') {
        const more = node.data('more') as MoreData;
        this.dispatch(this.moreListeners, (cb) => cb(more.parentId ?? null, more.offset));
        return;
      }
      const id = node.id();
      this.dispatch(this.selectListeners, (cb) => cb(id));
    });
    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) this.dispatch(this.selectListeners, (cb) => cb(null));
    });
    cy.on('dbltap', 'node', (evt: EventObject) => {
      const node = evt.target as NodeSingular;
      if (node.data('kind') === 'more') return;
      const id = node.id();
      this.dispatch(this.expandListeners, (cb) => cb(id));
    });
    cy.on('mouseover', 'node', (evt: EventObject) => {
      const node = evt.target as NodeSingular;
      this.hoveredId = node.id();
      node.addClass('hover');
    });
    cy.on('mouseout', 'node', (evt: EventObject) => {
      const node = evt.target as NodeSingular;
      if (this.hoveredId === node.id()) this.hoveredId = null;
      node.removeClass('hover');
    });
    cy.on('viewport', () => this.scheduleViewport());
  }

  private dispatch<T>(set: Set<T>, call: (cb: T) => void): void {
    if (set.size === 0) return;
    this.zone.run(() => {
      for (const cb of [...set]) call(cb);
    });
  }

  /** Viewport events fire on every pan/zoom frame: coalesce them. */
  private scheduleViewport(): void {
    if (this.viewportTimer !== null || this.destroyed) return;
    this.viewportTimer = setTimeout(() => {
      this.viewportTimer = null;
      const cy = this.cy;
      if (!cy) return;
      this.applyZoom(cy);
      if (this.viewportListeners.size === 0) return;
      const viewport: GraphViewport = { zoom: cy.zoom(), pan: { ...cy.pan() }, labels: !this.zoomedOut };
      this.dispatch(this.viewportListeners, (cb) => cb(viewport));
    }, VIEWPORT_THROTTLE_MS);
  }

  /**
   * Toggles the label class only when the zoom crosses the threshold, and
   * below it resizes the few labels that stay (hubs, selection) so they keep a
   * readable on-screen size: only when the rounded size changes.
   */
  private applyZoom(cy: Core): void {
    const font = zoomedLabelSize(cy.zoom());
    const zoomedOut = font !== null;
    if (zoomedOut !== this.zoomedOut) {
      this.zoomedOut = zoomedOut;
      cy.batch(() => {
        if (zoomedOut) cy.nodes().addClass('zo');
        else cy.nodes().removeClass('zo');
      });
    }
    if (font === null || font === this.labelFont) return;
    this.labelFont = font;
    cy.batch(() => {
      cy.nodes('.hub, .sel').data('zfs', font);
    });
  }

  private motion() {
    return { reducedMotion: this.options.reducedMotion };
  }

  private run(eles: Collection | NodeCollection, options: object): RunningLayout {
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (finish = resolve));
    if (this.destroyed || eles.empty()) {
      finish();
      return { stop: () => undefined, done };
    }
    const layout = eles.layout(options as LayoutOptions);
    layout.one('layoutstop', () => finish());
    this.zone.runOutsideAngular(() => layout.run());
    return {
      stop: () => {
        layout.stop();
        finish();
      },
      done,
    };
  }

  /**
   * Flies the new nodes out of `center` onto a spiral and pushes every other node
   * radially out of the way (planBurst). Positions are read when the queue starts
   * the job, after any earlier animation has settled.
   */
  private burst(key: string, burstId: string | null, center: Position, origin: number, added: NodeCollection): Promise<void> {
    if (added.empty()) return Promise.resolve();
    return this.queue.enqueue(key, () => {
      const cy = this.cy;
      const alive = added.filter((n) => n.inside());
      if (!cy || alive.empty()) return settled();
      const plan = planBurst(center, alive.map((n) => Number(n.data('size'))), origin, this.motion());
      const targets = new Map<string, Position>();
      alive.forEach((n, i) => {
        targets.set(n.id(), plan.positions[i] ?? center);
      });
      if (plan.shift > 0) {
        cy.nodes().difference(alive).forEach((n) => {
          const to = pushAway(center, n.position(), plan.shift, plan.radius);
          if (moves(n.position(), to)) targets.set(n.id(), to);
        });
      }
      if (burstId !== null) this.bursts.set(burstId, { center, shift: plan.shift, reach: plan.radius, origin });
      this.reveal(cy, center, plan.radius, plan.duration === 0);
      return this.moveTo(cy.nodes().filter((n) => targets.has(n.id())), targets, plan.duration === 0);
    });
  }

  /** Brings a burst that would land partly off screen into view, never zooming in. */
  private reveal(cy: Core, center: Position, radius: number, instant: boolean): void {
    const box = { x1: center.x - radius, y1: center.y - radius, x2: center.x + radius, y2: center.y + radius };
    const ext = cy.extent();
    if (box.x1 >= ext.x1 && box.x2 <= ext.x2 && box.y1 >= ext.y1 && box.y2 <= ext.y2) return;
    const width = cy.width();
    const height = cy.height();
    const zoom = Math.min(cy.zoom(), fitViewport(box, { width, height }, FIT_PADDING).zoom);
    const viewport = { zoom, pan: { x: width / 2 - zoom * center.x, y: height / 2 - zoom * center.y } };
    if (instant) cy.viewport(viewport);
    else this.zone.runOutsideAngular(() => cy.animate(viewport, { duration: BURST_ANIMATION_MS }));
  }

  private moveTo(nodes: NodeCollection, targets: ReadonlyMap<string, Position>, instant: boolean): RunningLayout {
    return this.run(nodes, {
      name: 'preset',
      positions: (n: NodeSingular) => targets.get(n.id()) ?? n.position(),
      animate: !instant,
      animationDuration: instant ? 0 : BURST_ANIMATION_MS,
      animationEasing: 'ease-out-cubic',
      fit: false,
    });
  }

  private addAround(cy: Core, center: Position, nodes: readonly ViewNode[], edges: readonly GraphViewEdge[]): NodeCollection {
    const fresh = nodes.filter((node) => cy.getElementById(node.id).empty());
    const defs = fresh.map((node) => ({ ...this.nodeElement(node), position: { ...center } }));
    let added: NodeCollection = cy.collection();
    cy.batch(() => {
      added = cy.add(defs).nodes();
      cy.add(this.edgeElements(cy, edges));
    });
    return added;
  }

  private nodeElement(node: ViewNode): ElementDefinition {
    if (isMoreNode(node)) {
      const more: MoreData = node.parentId === undefined ? { offset: node.offset } : { parentId: node.parentId, offset: node.offset };
      const data: Record<string, unknown> = {
        id: node.id,
        kind: 'more',
        label: this.options.moreLabel(node.remaining),
        size: MORE_NODE_SIZE,
        shape: 'round-tag',
        more,
      };
      if (node.parentId !== undefined) data['parentId'] = node.parentId;
      return { group: 'nodes', data: data as ElementDefinition['data'], classes: this.zoomedOut ? 'more zo' : 'more' };
    }
    const visual = graphStyle(node);
    const classes = [visual.paletteIndex === null ? 'cn' : `c${visual.paletteIndex}`];
    if (visual.ring) classes.push('hub');
    if (node.isTest) classes.push('test');
    if (this.zoomedOut) classes.push('zo');
    if (this.nodeFiltered(node.kind, node.isTest === true)) classes.push('filtered');
    const data: Record<string, unknown> = {
      id: node.id,
      kind: node.kind,
      label: node.label,
      zfs: this.labelFont,
      size: visual.size,
      shape: visual.shape,
      test: node.isTest === true,
      node,
    };
    if (node.parentId !== undefined) data['parentId'] = node.parentId;
    return { group: 'nodes', data: data as ElementDefinition['data'], classes };
  }

  private edgeElements(cy: Core, edges: readonly GraphViewEdge[]): ElementDefinition[] {
    const out: ElementDefinition[] = [];
    for (const edge of edges) {
      const id = edgeId(edge);
      if (cy.getElementById(id).nonempty()) continue;
      if (cy.getElementById(edge.source).empty() || cy.getElementById(edge.target).empty()) continue;
      const classes: string[] = [];
      if (this.selectedId !== null) {
        classes.push(edge.source === this.selectedId || edge.target === this.selectedId ? 'adj' : 'faded');
      }
      if (this.edgeFiltered(edge.weight)) classes.push('filtered');
      out.push({
        group: 'edges',
        data: {
          id,
          source: edge.source,
          target: edge.target,
          weight: edge.weight,
          width: edgeWidth(edge.weight),
          opacity: edgeOpacity(edge.weight),
        },
        classes,
      });
    }
    return out;
  }

  private nodeFiltered(kind: string, isTest: boolean): boolean {
    if (kind === 'more') return false;
    if (this.filters.hideTests && isTest) return true;
    return this.filters.hiddenKinds?.has(kind) ?? false;
  }

  private edgeFiltered(weight: number): boolean {
    return this.filters.minEdgeWeight !== undefined && weight < this.filters.minEdgeWeight;
  }

  private siblingCenter(cy: Core, parentId: string | null): Position | null {
    const siblings = cy.nodes().filter((n) => (n.data('parentId') as string | undefined) === (parentId ?? undefined));
    if (siblings.empty()) return null;
    const box = siblings.boundingBox();
    return { x: box.x1 + box.w / 2, y: box.y1 + box.h / 2 };
  }

  private viewCenter(cy: Core): Position {
    const ext = cy.extent();
    return { x: ext.x1 + ext.w / 2, y: ext.y1 + ext.h / 2 };
  }
}

function settled(): RunningLayout {
  return { stop: () => undefined, done: Promise.resolve() };
}

function moves(from: Position, to: Position): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > MIN_MOVE_PX;
}
