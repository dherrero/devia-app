import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import es from '../../../../../assets/i18n/es.json';
import type { GraphOverviewNode, GraphViewEdge, GraphViewPage } from '../../../../../../shared/domain/code-graph';
import { ElectronApiService } from '../../../../core/services/electron-api.service';
import { GraphViewStore } from '../../services/graph-view.store';
import { GraphFiltersComponent } from './graph-filters.component';

const P = 'proj';

function n(id: string, over: Partial<GraphOverviewNode> = {}): GraphOverviewNode {
  return { id, kind: 'dir', label: id, childCount: 1, path: id, ...over };
}

function e(source: string, target: string, kind: GraphViewEdge['kind'] = 'aggregate'): GraphViewEdge {
  return { source, target, kind, weight: 1 };
}

const OVERVIEW: GraphViewPage = {
  nodes: [n('dir:src'), n('f', { kind: 'file' }), n('t', { kind: 'file', isTest: true })],
  edges: [e('f', 'dir:src'), e('t', 'f', 'calls')],
  total: 3,
  hasMore: false,
};

describe('GraphFiltersComponent (S-44 T-511)', () => {
  let fixture: ComponentFixture<GraphFiltersComponent>;
  let store: GraphViewStore;
  let api: { codeGraphOverview: ReturnType<typeof vi.fn>; codeGraphExpand: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = { codeGraphOverview: vi.fn(() => Promise.resolve(OVERVIEW)), codeGraphExpand: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [GraphFiltersComponent, TranslateModule.forRoot()],
      providers: [GraphViewStore, { provide: ElectronApiService, useValue: api }],
    }).compileComponents();
    const t = TestBed.inject(TranslateService);
    t.setTranslation('es', es as Record<string, unknown>);
    t.use('es');
    store = TestBed.inject(GraphViewStore);
    await store.loadOverview(P);
    api.codeGraphOverview.mockClear();
    fixture = TestBed.createComponent(GraphFiltersComponent);
    fixture.detectChanges();
  });

  const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const chips = (group: string): HTMLButtonElement[] =>
    [...host().querySelectorAll<HTMLButtonElement>(`[data-testid="${group}"] button`)];
  const chip = (group: string, label: string): HTMLButtonElement => {
    const found = chips(group).find((b) => text(b) === label);
    if (!found) throw new Error(`no chip ${label} in ${group}: ${chips(group).map((b) => text(b)).join(', ')}`);
    return found;
  };
  const click = (el: HTMLElement): void => {
    el.click();
    fixture.detectChanges();
  };

  it('offers a pressed chip per node kind and relation kind on screen', () => {
    expect(chips('cg-filter-node-kinds').map((b) => text(b))).toEqual(['Directorio', 'Fichero']);
    expect(chips('cg-filter-edge-kinds').map((b) => text(b))).toEqual(['Llamadas', 'Relaciones agrupadas']);
    for (const b of [...chips('cg-filter-node-kinds'), ...chips('cg-filter-edge-kinds')]) {
      expect(b.getAttribute('aria-pressed')).toBe('true');
    }
    expect(host().querySelector('[data-testid="cg-filter-node-kinds"]')?.getAttribute('role')).toBe('group');
    expect(host().querySelector('[data-testid="cg-filter-node-kinds"]')?.getAttribute('aria-label')).toBe('Nodos');
  });

  it('turning a node kind off hides it through the store, without reloading', () => {
    click(chip('cg-filter-node-kinds', 'Directorio'));
    expect(store.filters().nodeKinds).not.toContain('dir');
    expect(store.filters().nodeKinds).toContain('file');
    expect(store.visibleNodes().map((x) => x.id)).toEqual(['f', 't']);
    expect(chip('cg-filter-node-kinds', 'Directorio').getAttribute('aria-pressed')).toBe('false');
    expect(api.codeGraphOverview).not.toHaveBeenCalled();
    expect(api.codeGraphExpand).not.toHaveBeenCalled();
  });

  it('turning it back on clears the kind filter', () => {
    click(chip('cg-filter-node-kinds', 'Directorio'));
    click(chip('cg-filter-node-kinds', 'Directorio'));
    expect(store.filters().nodeKinds).toBeUndefined();
  });

  it('turning a relation kind off hides those edges', () => {
    click(chip('cg-filter-edge-kinds', 'Llamadas'));
    expect(store.filters().edgeKinds).toContain('aggregate');
    expect(store.filters().edgeKinds).not.toContain('calls');
    expect(store.visibleEdges()).toEqual([e('f', 'dir:src')]);
  });

  it('keeps the chip of a hidden kind even when nothing of it is on screen any more', async () => {
    click(chip('cg-filter-node-kinds', 'Fichero'));
    api.codeGraphOverview.mockResolvedValueOnce({ ...OVERVIEW, nodes: [n('dir:src')], edges: [] });
    await store.loadOverview(P);
    fixture.detectChanges();
    expect(chips('cg-filter-node-kinds').map((b) => text(b))).toEqual(['Directorio', 'Fichero']);
  });

  it('switches tests and generated code', () => {
    const tests = chip('cg-filter-include', 'Tests');
    expect(tests.getAttribute('aria-pressed')).toBe('true');
    click(tests);
    expect(store.filters().showTests).toBe(false);
    expect(store.visibleNodes().map((x) => x.id)).toEqual(['dir:src', 'f']);
    click(chip('cg-filter-include', 'Código generado'));
    expect(store.filters().showGenerated).toBe(false);
  });

  it('counts what is hidden and "Mostrar todo" brings it back', () => {
    expect(host().querySelector('[data-testid="cg-filter-hidden"]')).toBeNull();
    click(chip('cg-filter-include', 'Tests'));
    expect(text(host().querySelector('[data-testid="cg-filter-hidden"]'))).toBe('2 elementos ocultos');
    const reset = host().querySelector<HTMLButtonElement>('[data-testid="cg-filter-reset"] button, button[data-testid="cg-filter-reset"]');
    if (!reset) throw new Error('no reset');
    click(reset);
    expect(store.filters()).toEqual({ showTests: true, showGenerated: true });
  });
});
