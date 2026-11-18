import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '../../../../../assets/i18n/es.json';
import type {
  GraphNode, GraphNodeDetail, GraphOverviewNode, GraphSymbolDetail, GraphViewPage,
} from '../../../../../../shared/domain/code-graph';
import { AppStateService } from '../../../../core/services/app-state.service';
import { ElectronApiService } from '../../../../core/services/electron-api.service';
import { GraphViewStore } from '../../services/graph-view.store';
import { NodeDetailComponent } from './node-detail.component';

const P = 'proj';

function ov(id: string, over: Partial<GraphOverviewNode> = {}): GraphOverviewNode {
  return { id, kind: 'function', label: id, childCount: 0, path: 'src/lib/util.ts', ...over };
}

function gn(id: string, name: string, filePath: string, startLine = 1): GraphNode {
  return {
    id, kind: 'function', name, qualifiedName: name, filePath, language: 'typescript', startLine, endLine: startLine + 2, isExported: true,
  };
}

const OVERVIEW: GraphViewPage = {
  nodes: [ov('fn:helper'), ov('fn:run', { path: 'src/app/main.ts' }), ov('fn:deep', { path: 'src/app/deep.ts' }), ov('dir:src', { kind: 'dir', path: 'src', childCount: 3 })],
  edges: [],
  total: 4,
  hasMore: false,
};

function helperDetail(): GraphSymbolDetail {
  return {
    kind: 'symbol',
    node: { ...gn('fn:helper', 'helper', 'src/lib/util.ts', 2), signature: 'helper(s: string): string', docstring: 'Trims a string.' },
    ancestors: ['dir:src', 'dir:src/lib', 'file:util'],
    callers: [gn('fn:run', 'run', 'src/app/main.ts', 4), gn('fn:deep', 'deep', 'src/app/deep.ts', 3)],
    callees: [gn('fn:trim', 'trim', 'src/lib/util.ts', 9)],
    impact: {
      files: ['src/lib/util.ts', 'src/app/main.ts', 'src/app/deep.ts'],
      refs: [{ id: 'file:util', path: 'src/lib/util.ts' }, { id: 'file:main', path: 'src/app/main.ts' }, { id: 'file:deep', path: 'src/app/deep.ts' }],
      count: 3,
      truncated: false,
    },
    signature: 'helper(s: string): string',
    docstring: 'Trims a string.',
  };
}

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('NodeDetailComponent (S-44 T-511)', () => {
  let fixture: ComponentFixture<NodeDetailComponent>;
  let store: GraphViewStore;
  let writeText: ReturnType<typeof vi.fn>;
  const api = {
    codeGraphOverview: vi.fn(() => Promise.resolve(OVERVIEW)),
    codeGraphExpand: vi.fn(),
    codeGraphNodeDetail: vi.fn<(p: string, id: string) => Promise<GraphNodeDetail | undefined>>(),
    openInIde: vi.fn<(p: string) => Promise<true>>(() => Promise.resolve(true)),
  };

  beforeEach(async () => {
    api.codeGraphOverview.mockClear();
    api.codeGraphNodeDetail.mockReset();
    api.codeGraphNodeDetail.mockImplementation((_p, id) => Promise.resolve(id === 'fn:helper' ? helperDetail() : undefined));
    api.openInIde.mockClear();
    writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await TestBed.configureTestingModule({
      imports: [NodeDetailComponent, TranslateModule.forRoot()],
      providers: [
        GraphViewStore,
        { provide: ElectronApiService, useValue: api },
        { provide: AppStateService, useValue: { config: signal({ workspaceRoot: '/ws' }) } },
      ],
    }).compileComponents();
    const t = TestBed.inject(TranslateService);
    t.setTranslation('es', es as Record<string, unknown>);
    t.use('es');
    store = TestBed.inject(GraphViewStore);
    await store.show(P, 1);
    fixture = TestBed.createComponent(NodeDetailComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.unstubAllGlobals();
  });

  const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = (id: string): HTMLElement | null => host().querySelector(`[data-testid="${id}"]`);
  const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const items = (list: string): HTMLButtonElement[] => [...host().querySelectorAll<HTMLButtonElement>(`[data-testid="${list}"] button`)];
  const button = (id: string): HTMLButtonElement => {
    const el = host().querySelector<HTMLButtonElement>(`[data-testid="${id}"] button, button[data-testid="${id}"]`);
    if (!el) throw new Error(`no button ${id}`);
    return el;
  };

  async function settle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();
    }
  }

  async function selectNode(id: string | null): Promise<void> {
    store.select(id);
    fixture.detectChanges();
    await settle();
  }

  it('without a selection shows help, including the search shortcut', () => {
    const empty = byId('cg-detail-empty');
    expect(text(empty)).toContain('Selecciona un nodo');
    expect(text(empty)).toContain('Buscar:');
    expect(api.codeGraphNodeDetail).not.toHaveBeenCalled();
  });

  it('is a labelled region', () => {
    const region = host().querySelector('[role="region"]');
    expect(region?.getAttribute('aria-label')).toBe('Detalle del nodo');
  });

  it('describes a symbol: name, kind, file:line, signature and docstring', async () => {
    await selectNode('fn:helper');
    expect(api.codeGraphNodeDetail).toHaveBeenCalledWith(P, 'fn:helper');
    expect(text(byId('cg-detail-name'))).toBe('helper');
    expect(text(byId('cg-detail-kind'))).toBe('Función');
    expect(text(byId('cg-detail-location'))).toBe('src/lib/util.ts:2');
    expect(text(byId('cg-detail-signature'))).toBe('helper(s: string): string');
    expect(text(byId('cg-detail-docstring'))).toBe('Trims a string.');
  });

  it('lists 2 callers, the callees and "Impacto: 3 ficheros" with the affected paths', async () => {
    await selectNode('fn:helper');
    expect(items('cg-detail-callers').map((b) => text(b))).toEqual([
      expect.stringContaining('run'), expect.stringContaining('deep'),
    ]);
    expect(text(byId('cg-detail-callers-title'))).toContain('2');
    expect(items('cg-detail-callees')).toHaveLength(1);
    expect(text(byId('cg-detail-impact-title'))).toBe('Impacto: 3 ficheros');
    expect(text(byId('cg-detail-impact'))).toContain('Estos ficheros se verían afectados');
    expect(items('cg-detail-impact').map((b) => text(b))).toEqual(['src/lib/util.ts', 'src/app/main.ts', 'src/app/deep.ts']);
  });

  it('clicking a caller selects it (reveals it in the graph)', async () => {
    await selectNode('fn:helper');
    items('cg-detail-callers')[0]?.click();
    await settle();
    expect(store.selectedId()).toBe('fn:run');
  });

  it('an impact file reveals its file node', async () => {
    await selectNode('fn:helper');
    const reveal = vi.spyOn(store, 'revealNode');
    items('cg-detail-impact')[1]?.click();
    expect(reveal).toHaveBeenCalledWith('file:main');
  });

  it('the newest selection wins over a slower detail', async () => {
    const slow = deferred<GraphNodeDetail | undefined>();
    api.codeGraphNodeDetail.mockImplementationOnce(() => slow.promise);
    store.select('fn:run');
    fixture.detectChanges();
    await selectNode('fn:helper');
    slow.resolve({ ...helperDetail(), node: gn('fn:run', 'run', 'src/app/main.ts') });
    await settle();
    expect(text(byId('cg-detail-name'))).toBe('helper');
  });

  it('says so when the node is gone, and when the detail fails', async () => {
    await selectNode('fn:deep');
    expect(text(byId('cg-detail-missing'))).toBe('Este elemento ya no está en el grafo.');
    api.codeGraphNodeDetail.mockRejectedValueOnce(new Error('boom'));
    await selectNode('fn:run');
    expect(text(byId('cg-detail-error'))).toBe('No se pudo cargar el detalle.');
  });

  it('copies the absolute path and confirms it in a live region', async () => {
    await selectNode('fn:helper');
    button('cg-detail-copy').click();
    await settle();
    expect(writeText).toHaveBeenCalledWith('/ws/proj/src/lib/util.ts');
    expect(text(byId('cg-detail-live'))).toBe('Ruta copiada');
    expect(byId('cg-detail-live')?.getAttribute('aria-live')).toBe('polite');
  });

  it('opens the file through the existing openInIde bridge call', async () => {
    await selectNode('fn:helper');
    button('cg-detail-open').click();
    await settle();
    expect(api.openInIde).toHaveBeenCalledWith('/ws/proj/src/lib/util.ts');
  });

  it('reports an IDE that could not open the file', async () => {
    api.openInIde.mockRejectedValueOnce(new Error('no ide'));
    await selectNode('fn:helper');
    button('cg-detail-open').click();
    await settle();
    expect(text(byId('cg-detail-live'))).toBe('No se pudo abrir el fichero en el IDE.');
  });

  it('describes a file with what it imports and what imports it', async () => {
    api.codeGraphNodeDetail.mockResolvedValueOnce({
      kind: 'file',
      node: { ...gn('file:main', 'src/app/main.ts', 'src/app/main.ts'), kind: 'file' },
      path: 'src/app/main.ts',
      language: 'typescript',
      ancestors: ['dir:src', 'dir:src/app'],
      symbolCount: 4,
      importedBy: [{ id: 'file:index', path: 'index.ts' }],
      importedByCount: 1,
      imports: [{ id: 'file:util', path: 'src/lib/util.ts' }],
      importsCount: 3,
    });
    await selectNode('fn:run');
    expect(text(byId('cg-detail-name'))).toBe('main.ts');
    expect(text(byId('cg-detail-location'))).toBe('src/app/main.ts');
    expect(items('cg-detail-imports').map((b) => text(b))).toEqual(['src/lib/util.ts']);
    expect(text(byId('cg-detail-imports'))).toContain('…y 2 más');
    expect(items('cg-detail-imported-by').map((b) => text(b))).toEqual(['index.ts']);
  });

  it('describes a directory with its counts and central nodes', async () => {
    api.codeGraphNodeDetail.mockResolvedValueOnce({
      kind: 'dir', id: 'dir:src', path: 'src', ancestors: [], fileCount: 3, symbolCount: 1,
      languages: { typescript: 3 }, topHubs: [gn('fn:helper', 'helper', 'src/lib/util.ts')], communities: [],
    });
    await selectNode('dir:src');
    expect(text(byId('cg-detail-name'))).toBe('src');
    expect(text(byId('cg-detail-counts'))).toContain('3 ficheros');
    expect(text(byId('cg-detail-counts'))).toContain('1 símbolo');
    expect(items('cg-detail-hubs').map((b) => text(b))).toEqual([expect.stringContaining('helper')]);
  });

  it('refetches the detail when the graph changes on disk', async () => {
    await selectNode('fn:helper');
    expect(api.codeGraphNodeDetail).toHaveBeenCalledTimes(1);
    await store.show(P, 2);
    await settle();
    expect(api.codeGraphNodeDetail).toHaveBeenCalledTimes(2);
    expect(text(byId('cg-detail-name'))).toBe('helper');
  });

  it('clearing the selection goes back to the help', async () => {
    await selectNode('fn:helper');
    await selectNode(null);
    expect(byId('cg-detail-empty')).not.toBeNull();
  });
});
