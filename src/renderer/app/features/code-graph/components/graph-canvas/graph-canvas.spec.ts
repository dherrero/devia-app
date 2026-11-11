import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GraphExpandOptions, GraphOverviewNode, GraphOverviewOptions, GraphViewEdge, GraphViewPage,
} from '../../../../../../shared/domain/code-graph';
import es from '../../../../../assets/i18n/es.json';
import { ElectronApiService } from '../../../../core/services/electron-api.service';
import { GRAPH_RENDERER_FACTORY, type GraphRendererOptions } from '../../services/graph-renderer';
import { GraphViewStore, moreNodeId } from '../../services/graph-view.store';
import { FakeGraphRenderer } from '../../testing/fake-graph-renderer';
import { GraphCanvasComponent } from './graph-canvas.component';

const P = '/ws/proj';

function n(id: string, over: Partial<GraphOverviewNode> = {}): GraphOverviewNode {
  return { id, kind: 'dir', label: id.replace(/^dir:/, ''), childCount: 2, path: id.replace(/^dir:/, ''), ...over };
}

function e(source: string, target: string, weight = 1): GraphViewEdge {
  return { source, target, kind: 'aggregate', weight };
}

function page(nodes: GraphOverviewNode[], edges: GraphViewEdge[] = [], over: Partial<GraphViewPage> = {}): GraphViewPage {
  return { nodes, edges, total: nodes.length, hasMore: false, ...over };
}

const OVERVIEW = (): GraphViewPage => page([n('dir:src'), n('dir:lib'), n('dir:docs', { childCount: 0 })], [e('dir:src', 'dir:lib', 3)]);

function expandPage(id: string): GraphViewPage {
  if (id === 'dir:src') {
    return page([
      n('f:a', { kind: 'file', label: 'a.ts', path: 'src/a.ts', parentId: 'dir:src', childCount: 1 }),
      n('f:b', { kind: 'file', label: 'b.ts', path: 'src/b.ts', parentId: 'dir:src', childCount: 0 }),
    ], [e('f:a', 'dir:lib', 2)]);
  }
  if (id === 'dir:lib') {
    return page([n('f:l0', { kind: 'file', parentId: 'dir:lib', childCount: 0 })], [], { total: 3, hasMore: true });
  }
  return page([]);
}

function makeApi() {
  return {
    codeGraphOverview: vi.fn<(p: string, o?: GraphOverviewOptions) => Promise<GraphViewPage>>(() => Promise.resolve(OVERVIEW())),
    codeGraphExpand: vi.fn((_p: string, id: string, o?: GraphExpandOptions) =>
      Promise.resolve(o?.offset ? page([n('f:l1', { kind: 'file', parentId: 'dir:lib', childCount: 0 })], [], { total: 3 }) : expandPage(id))),
  };
}

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(readonly cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  fire(): void {
    this.cb();
  }
}

describe('GraphCanvasComponent (S-44 T-510)', () => {
  let fixture: ComponentFixture<GraphCanvasComponent>;
  let api: ReturnType<typeof makeApi>;
  let renderer: FakeGraphRenderer;
  let factory: ReturnType<typeof vi.fn<(o: GraphRendererOptions) => Promise<FakeGraphRenderer>>>;
  let store: GraphViewStore;
  let reducedMotion = false;

  beforeEach(async () => {
    api = makeApi();
    renderer = new FakeGraphRenderer();
    factory = vi.fn<(o: GraphRendererOptions) => Promise<FakeGraphRenderer>>(() => Promise.resolve(renderer));
    reducedMotion = false;
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce') ? reducedMotion : false,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    await TestBed.configureTestingModule({
      imports: [GraphCanvasComponent, TranslateModule.forRoot()],
      providers: [
        GraphViewStore,
        { provide: ElectronApiService, useValue: api },
        { provide: GRAPH_RENDERER_FACTORY, useValue: factory },
      ],
    }).compileComponents();
    const t = TestBed.inject(TranslateService);
    t.setTranslation('es', es as Record<string, unknown>);
    t.use('es');
    store = TestBed.inject(GraphViewStore);
  });

  afterEach(() => {
    fixture?.destroy();
    document.documentElement.removeAttribute('data-theme');
    vi.unstubAllGlobals();
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();
    }
  }

  async function mount(revision?: number): Promise<void> {
    fixture = TestBed.createComponent(GraphCanvasComponent);
    fixture.componentRef.setInput('project', P);
    if (revision !== undefined) fixture.componentRef.setInput('revision', revision);
    document.body.appendChild(fixture.nativeElement as HTMLElement);
    fixture.detectChanges();
    await settle();
  }

  const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = (id: string): HTMLElement | null => host().querySelector(`[data-testid="${id}"]`);
  const surface = (): HTMLElement => {
    const el = byId('cg-canvas');
    if (!el) throw new Error('no canvas surface');
    return el;
  };
  const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const live = (): string => text(byId('cg-canvas-live'));
  const key = (k: string, extra: KeyboardEventInit = {}): void => {
    surface().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
    fixture.detectChanges();
  };
  const click = (id: string): void => {
    const el = host().querySelector<HTMLButtonElement>(`[data-testid="${id}"] button, button[data-testid="${id}"]`);
    if (!el) throw new Error(`no button ${id}`);
    el.click();
    fixture.detectChanges();
  };

  describe('mounting', () => {
    it('creates the renderer through the factory, mounts it on the surface and passes the overview', async () => {
      await mount();
      expect(factory).toHaveBeenCalledTimes(1);
      expect(renderer.mounted).toBe(surface());
      expect(api.codeGraphOverview).toHaveBeenCalledWith(P);
      const [, nodes, edges] = renderer.callsOf('setElements').at(-1) ?? [];
      expect((nodes as GraphOverviewNode[]).map((x) => x.id)).toEqual(['dir:src', 'dir:lib', 'dir:docs']);
      expect(edges).toEqual([e('dir:src', 'dir:lib', 3)]);
    });

    it('translates the label of the "more" nodes for the renderer', async () => {
      await mount();
      const options = factory.mock.calls[0]?.[0];
      expect(options?.moreLabel(1)).toBe('Ver 1 más');
      expect(options?.moreLabel(12)).toBe('Ver 12 más');
    });

    it('is an application region with a Spanish name and keyboard help', async () => {
      await mount();
      expect(surface().getAttribute('role')).toBe('application');
      expect(surface().getAttribute('aria-label')).toBe('Grafo de código del proyecto');
      expect(surface().getAttribute('tabindex')).toBe('0');
      const help = surface().getAttribute('aria-describedby');
      expect(help && text(document.getElementById(help))).toContain('Intro');
    });

    it('shows the visible element counter with the plural convention', async () => {
      await mount();
      expect(text(byId('cg-canvas-count'))).toBe('3 elementos visibles');
      api.codeGraphOverview.mockResolvedValueOnce(page([n('dir:only')]));
      await store.loadOverview(P);
      fixture.detectChanges();
      expect(text(byId('cg-canvas-count'))).toBe('1 elemento visible');
    });

    it('renders a legend for colours (community) and shapes (kind)', async () => {
      await mount();
      const legend = text(byId('cg-canvas-legend'));
      expect(legend).toContain('Color: comunidad');
      expect(legend).toContain('Directorio');
      expect(legend).toContain('Fichero');
    });
  });

  describe('pointer interactions', () => {
    it('a click selects: the store and the renderer follow, and the live region names the node', async () => {
      await mount();
      renderer.emitSelect('dir:src');
      fixture.detectChanges();
      expect(store.selectedId()).toBe('dir:src');
      expect(renderer.callsOf('select').at(-1)).toEqual(['select', 'dir:src']);
      expect(live()).toContain('src');
      expect(live()).toContain('Directorio');
    });

    it('a double click explodes an expandable node and announces how many elements appeared', async () => {
      await mount();
      renderer.emitExpandRequest('dir:src');
      await settle();
      expect(api.codeGraphExpand).toHaveBeenCalledWith(P, 'dir:src', expect.objectContaining({ visibleIds: expect.any(Array) }));
      const [, parentId, nodes] = renderer.callsOf('explode').at(-1) ?? [];
      expect(parentId).toBe('dir:src');
      expect((nodes as GraphOverviewNode[]).map((x) => x.id)).toEqual(['f:a', 'f:b']);
      expect(live()).toBe('Expandido src: 2 elementos');
    });

    it('the second action collapses: a double click on a leaf child collapses its expansion', async () => {
      await mount();
      renderer.emitExpandRequest('dir:src');
      await settle();
      renderer.emitExpandRequest('f:b');
      await settle();
      const [, id, childIds] = renderer.callsOf('collapse').at(-1) ?? [];
      expect(id).toBe('dir:src');
      expect([...(childIds as string[])].sort()).toEqual(['f:a', 'f:b']);
      expect(live()).toBe('Contraído src');
    });

    it('a click on a "more" node loads the next page', async () => {
      await mount();
      renderer.emitExpandRequest('dir:lib');
      await settle();
      renderer.emitShowMore('dir:lib', 1);
      await settle();
      expect(api.codeGraphExpand).toHaveBeenLastCalledWith(P, 'dir:lib', expect.objectContaining({ offset: 1 }));
      expect(renderer.callsOf('removeNode').at(-1)).toEqual(['removeNode', moreNodeId('dir:lib', 1)]);
      const [, parentId, nodes] = renderer.callsOf('addNodes').at(-1) ?? [];
      expect(parentId).toBe('dir:lib');
      expect((nodes as GraphOverviewNode[]).map((x) => x.id)).toContain('f:l1');
    });

    it('the selection bar offers expand for an expandable node and collapse for a child', async () => {
      await mount();
      renderer.emitSelect('dir:src');
      fixture.detectChanges();
      click('cg-canvas-expand');
      await settle();
      expect(store.expanded().has('dir:src')).toBe(true);
      renderer.emitSelect('f:b');
      fixture.detectChanges();
      expect(byId('cg-canvas-expand')).toBeNull();
      click('cg-canvas-collapse');
      await settle();
      expect(store.expanded().has('dir:src')).toBe(false);
      expect(store.selectedId()).toBe('dir:src');
    });
  });

  describe('keyboard', () => {
    it('Enter expands the selected node, Backspace collapses its expansion, Escape clears the selection', async () => {
      await mount();
      renderer.emitSelect('dir:src');
      key('Enter');
      await settle();
      expect(store.expanded().has('dir:src')).toBe(true);
      renderer.emitSelect('f:a');
      key('Backspace');
      await settle();
      expect(store.expanded().has('dir:src')).toBe(false);
      key('Escape');
      expect(store.selectedId()).toBeNull();
      expect(renderer.callsOf('select').at(-1)).toEqual(['select', null]);
    });

    it('Space on an expanded child with no children collapses (second action)', async () => {
      await mount();
      renderer.emitSelect('dir:src');
      key(' ');
      await settle();
      renderer.emitSelect('f:b');
      key(' ');
      await settle();
      expect(store.expanded().size).toBe(0);
    });

    it('+ / - / 0 zoom and fit, arrows pan', async () => {
      await mount();
      key('+');
      key('-');
      key('0');
      key('ArrowLeft');
      key('ArrowRight');
      key('ArrowUp');
      key('ArrowDown');
      expect(renderer.callsOf('zoomBy').map((c) => c[1])).toEqual([1.25, 0.8]);
      expect(renderer.callsOf('fit')).toHaveLength(1);
      expect(renderer.callsOf('panBy').map((c) => [c[1], c[2]])).toEqual([[80, 0], [-80, 0], [0, 80], [0, -80]]);
    });

    it('] and [ walk the nodes in order, selecting and centring each', async () => {
      await mount();
      key(']');
      expect(store.selectedId()).toBe('dir:src');
      key(']');
      expect(store.selectedId()).toBe('dir:lib');
      key('[');
      expect(store.selectedId()).toBe('dir:src');
      key('[');
      expect(store.selectedId()).toBe('dir:docs');
      expect(renderer.callsOf('focus').map((c) => c[1])).toEqual(['dir:src', 'dir:lib', 'dir:src', 'dir:docs']);
    });

    it('Enter on a "more" node reached with ] loads the next page', async () => {
      await mount();
      renderer.emitExpandRequest('dir:lib');
      await settle();
      key(']');
      key(']');
      key(']');
      expect(store.selectedId()).toBe(moreNodeId('dir:lib', 1));
      key('Enter');
      await settle();
      expect(api.codeGraphExpand).toHaveBeenLastCalledWith(P, 'dir:lib', expect.objectContaining({ offset: 1 }));
    });

    it('ignores keys with modifiers so app shortcuts keep working', async () => {
      await mount();
      key('0', { ctrlKey: true });
      key('+', { metaKey: true });
      expect(renderer.callsOf('fit')).toHaveLength(0);
      expect(renderer.callsOf('zoomBy')).toHaveLength(0);
    });
  });

  describe('overlay controls', () => {
    it('zoom in / zoom out / fit buttons have accessible Spanish names', async () => {
      await mount();
      const label = (id: string) => host().querySelector(`[data-testid="${id}"] button`)?.getAttribute('aria-label');
      expect(label('cg-zoom-in')).toBe('Acercar');
      expect(label('cg-zoom-out')).toBe('Alejar');
      expect(label('cg-fit')).toBe('Encuadrar el grafo');
      click('cg-zoom-in');
      click('cg-zoom-out');
      click('cg-fit');
      expect(renderer.callsOf('zoomBy').map((c) => c[1])).toEqual([1.25, 0.8]);
      expect(renderer.callsOf('fit')).toHaveLength(1);
    });

    it('shows the store notice translated with its count, and dismisses it', async () => {
      await mount();
      (store as unknown as { _notice: { set(v: unknown): void } })._notice.set({
        key: 'codeGraph.canvas.collapsed_notice_plural',
        params: { count: 2 },
      });
      fixture.detectChanges();
      expect(text(byId('cg-canvas-notice'))).toContain('Se han contraído 2 nodos antiguos');
      click('cg-canvas-notice-dismiss');
      expect(store.notice()).toBeNull();
      expect(byId('cg-canvas-notice')).toBeNull();
    });
  });

  describe('states', () => {
    it('shows a loading skeleton while the overview loads', async () => {
      const slow = deferred<GraphViewPage>();
      api.codeGraphOverview.mockReturnValueOnce(slow.promise);
      await mount();
      expect(byId('cg-canvas-loading')).not.toBeNull();
      expect(text(byId('cg-canvas-loading'))).toContain('Cargando el grafo');
      slow.resolve(OVERVIEW());
      await settle();
      expect(byId('cg-canvas-loading')).toBeNull();
    });

    it('renders the empty state with a retry', async () => {
      api.codeGraphOverview.mockResolvedValueOnce(page([]));
      await mount();
      expect(text(byId('cg-canvas-empty'))).toContain('El grafo no tiene elementos que mostrar');
      click('cg-canvas-retry');
      await settle();
      expect(api.codeGraphOverview).toHaveBeenCalledTimes(2);
      expect(byId('cg-canvas-empty')).toBeNull();
    });

    it('renders a load error with a retry and no raw IPC text', async () => {
      api.codeGraphOverview.mockRejectedValueOnce(new Error("Error invoking remote method 'code-graph:overview': Error: Code graph operation failed"));
      await mount();
      expect(text(byId('cg-canvas-error'))).toContain('No se pudo cargar el grafo');
      expect(host().textContent).not.toContain('Error invoking remote method');
      click('cg-canvas-retry');
      await settle();
      expect(byId('cg-canvas-error')).toBeNull();
      expect(renderer.callsOf('setElements').length).toBeGreaterThan(0);
    });

    it('an expand failure keeps the graph and shows a dismissible alert', async () => {
      await mount();
      api.codeGraphExpand.mockRejectedValueOnce(new Error('boom'));
      renderer.emitExpandRequest('dir:src');
      await settle();
      expect(byId('cg-canvas-error')).toBeNull();
      expect(text(byId('cg-canvas-action-error'))).toContain('No se pudo completar la acción');
      click('cg-canvas-action-error-dismiss');
      expect(store.error()).toBeNull();
    });
  });

  describe('reload', () => {
    it('reloads when the revision changes, keeping expansions and the selection', async () => {
      await mount(1);
      renderer.emitExpandRequest('dir:src');
      await settle();
      renderer.emitSelect('f:a');
      fixture.componentRef.setInput('revision', 2);
      fixture.detectChanges();
      await settle();
      expect(api.codeGraphOverview).toHaveBeenCalledTimes(2);
      expect(store.expanded().has('dir:src')).toBe(true);
      expect(store.selectedId()).toBe('f:a');
      expect(renderer.callsOf('select').at(-1)).toEqual(['select', 'f:a']);
    });

    it('a re-created canvas re-applies the graph the page-level store already holds', async () => {
      await mount(1);
      renderer.emitExpandRequest('dir:src');
      await settle();
      renderer.emitSelect('f:a');
      fixture.destroy();
      renderer = new FakeGraphRenderer();
      factory.mockImplementation(() => Promise.resolve(renderer));
      await mount(1);
      expect(store.expanded().has('dir:src')).toBe(true);
      expect(store.selectedId()).toBe('f:a');
      const [, nodes] = renderer.callsOf('setElements').at(-1) ?? [];
      expect((nodes as GraphOverviewNode[]).map((x) => x.id)).toContain('f:a');
    });
  });

  describe('lifecycle, theme, motion', () => {
    it('resizes the renderer on container resize, and destroy releases renderer, observers and store listeners', async () => {
      await mount();
      const observer = FakeResizeObserver.instances[0];
      expect(observer?.observed).toContain(surface());
      observer?.fire();
      expect(renderer.callsOf('resize')).toHaveLength(1);

      fixture.destroy();
      expect(renderer.destroyed).toBe(true);
      expect(observer?.disconnected).toBe(true);
      const calls = renderer.calls.length;
      await store.loadOverview(P);
      renderer.emitSelect('dir:src');
      document.documentElement.setAttribute('data-theme', 'dark');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(renderer.calls.length).toBe(calls);
    });

    it('destroys a renderer that arrives after the component is gone', async () => {
      const late = deferred<FakeGraphRenderer>();
      factory.mockReturnValueOnce(late.promise);
      await mount();
      fixture.destroy();
      late.resolve(renderer);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(renderer.destroyed).toBe(true);
      expect(renderer.mounted).toBeNull();
    });

    it('a theme switch refreshes the renderer colours', async () => {
      await mount();
      document.documentElement.setAttribute('data-theme', 'dark');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(renderer.callsOf('refreshTheme')).toHaveLength(1);
    });

    it('passes prefers-reduced-motion to the renderer', async () => {
      reducedMotion = true;
      await mount();
      expect(factory.mock.calls[0]?.[0].reducedMotion).toBe(true);
    });

    it('animates by default', async () => {
      await mount();
      expect(factory.mock.calls[0]?.[0].reducedMotion).toBe(false);
    });
  });
});
