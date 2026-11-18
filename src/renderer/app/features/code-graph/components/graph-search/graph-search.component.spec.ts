import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '../../../../../assets/i18n/es.json';
import type { GraphSearchResult } from '../../../../../../shared/domain/code-graph';
import { ElectronApiService } from '../../../../core/services/electron-api.service';
import { GraphViewStore } from '../../services/graph-view.store';
import { GraphSearchComponent } from './graph-search.component';

const P = 'proj';

function hit(id: string, label: string, path: string, kind: GraphSearchResult['node']['kind'] = 'function'): GraphSearchResult {
  return { node: { id, kind, label, path, childCount: 0 }, ancestors: ['dir:src', `file:${path}`], score: 1 };
}

const THREE = [hit('fn:greet', 'greet', 'src/greeter.ts'), hit('fn:greetAll', 'greetAll', 'src/greeter.ts'), hit('file:g', 'greeter.ts', 'src/greeter.ts', 'file')];

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('GraphSearchComponent (S-44 T-511)', () => {
  let fixture: ComponentFixture<GraphSearchComponent>;
  let search: ReturnType<typeof vi.fn<(p: string, q: string) => Promise<GraphSearchResult[]>>>;
  let store: { projectKey: ReturnType<typeof signal<string | null>>; revealNode: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    search = vi.fn<(p: string, q: string) => Promise<GraphSearchResult[]>>(() => Promise.resolve(THREE));
    store = { projectKey: signal<string | null>(P), revealNode: vi.fn(() => Promise.resolve()) };
    await TestBed.configureTestingModule({
      imports: [GraphSearchComponent, TranslateModule.forRoot()],
      providers: [
        { provide: ElectronApiService, useValue: { codeGraphSearch: search } },
        { provide: GraphViewStore, useValue: store },
      ],
    }).compileComponents();
    const t = TestBed.inject(TranslateService);
    t.setTranslation('es', es as Record<string, unknown>);
    t.use('es');
    fixture = TestBed.createComponent(GraphSearchComponent);
    document.body.appendChild(fixture.nativeElement as HTMLElement);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const input = (): HTMLInputElement => {
    const el = host().querySelector<HTMLInputElement>('[data-testid="cg-search-input"]');
    if (!el) throw new Error('no search input');
    return el;
  };
  const options = (): HTMLElement[] => [...host().querySelectorAll<HTMLElement>('[role="option"]')];
  const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const status = (): string => text(host().querySelector('[data-testid="cg-search-status"]'));

  function type(value: string): void {
    input().value = value;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function key(k: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    input().dispatchEvent(event);
    fixture.detectChanges();
    return event;
  }

  async function settle(ms = 250): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('is a labelled combobox with spellcheck off', () => {
    const el = input();
    expect(el.getAttribute('role')).toBe('combobox');
    expect(el.getAttribute('spellcheck')).toBe('false');
    expect(el.getAttribute('aria-label')).toBe('Buscar en el grafo');
    expect(el.getAttribute('aria-expanded')).toBe('false');
    expect(el.getAttribute('aria-autocomplete')).toBe('list');
    expect(el.getAttribute('aria-keyshortcuts')).toContain('F');
  });

  it('debounces 250 ms and only asks for the last text typed', async () => {
    type('gr');
    await settle(100);
    type('greet');
    await settle(200);
    expect(search).not.toHaveBeenCalled();
    await settle(50);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(P, 'greet');
  });

  it('lists the results with their kind and path, and announces the count', async () => {
    type('greet');
    await settle();
    expect(options()).toHaveLength(3);
    expect(text(options()[0] ?? null)).toContain('greet');
    expect(text(options()[0] ?? null)).toContain('src/greeter.ts');
    expect(text(options()[0] ?? null)).toContain('Función');
    expect(input().getAttribute('aria-expanded')).toBe('true');
    const listbox = host().querySelector('[role="listbox"]');
    expect(input().getAttribute('aria-controls')).toBe(listbox?.id);
    expect(status()).toBe('3 resultados');
    expect(host().querySelector('[data-testid="cg-search-status"]')?.getAttribute('aria-live')).toBe('polite');
  });

  it('Enter on the first result reveals it (with its ancestors) and closes the list', async () => {
    type('greet');
    await settle();
    const event = key('Enter');
    expect(event.defaultPrevented).toBe(true);
    expect(store.revealNode).toHaveBeenCalledWith('fn:greet', ['dir:src', 'file:src/greeter.ts']);
    expect(options()).toHaveLength(0);
    expect(input().value).toBe('greet');
  });

  it('arrows move the active option (aria-activedescendant) and Enter takes it', async () => {
    type('greet');
    await settle();
    key('ArrowDown');
    key('ArrowDown');
    const active = options()[1];
    expect(active?.getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe(active?.id);
    key('ArrowUp');
    key('ArrowUp');
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[2]?.id);
    key('Enter');
    expect(store.revealNode).toHaveBeenCalledWith('file:g', ['dir:src', 'file:src/greeter.ts']);
  });

  it('a click on a result reveals it', async () => {
    type('greet');
    await settle();
    options()[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(store.revealNode).toHaveBeenCalledWith('fn:greetAll', ['dir:src', 'file:src/greeter.ts']);
  });

  it('shows at most 50 results', async () => {
    search.mockResolvedValueOnce(Array.from({ length: 70 }, (_, i) => hit(`n${i}`, `n${i}`, 'a.ts')));
    type('n');
    await settle();
    expect(options()).toHaveLength(50);
  });

  it('drops a slower answer to an older query', async () => {
    const slow = deferred<GraphSearchResult[]>();
    search.mockReturnValueOnce(slow.promise);
    type('old');
    await settle();
    search.mockResolvedValueOnce([hit('new', 'newer', 'b.ts')]);
    type('newer');
    await settle();
    slow.resolve(THREE);
    await settle(0);
    expect(options().map((o) => text(o))).toEqual([expect.stringContaining('newer')]);
  });

  it('says so when nothing matches, and an empty text clears without asking', async () => {
    search.mockResolvedValueOnce([]);
    type('zzz');
    await settle();
    expect(status()).toBe('Sin resultados para «zzz»');
    type('   ');
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    expect(status()).toBe('');
  });

  it('reports a failed search without breaking', async () => {
    search.mockRejectedValueOnce(new Error('boom'));
    type('x');
    await settle();
    expect(status()).toBe('No se pudo buscar.');
    expect(options()).toHaveLength(0);
  });

  it('Escape closes the list first, then clears the text', async () => {
    type('greet');
    await settle();
    key('Escape');
    expect(options()).toHaveLength(0);
    expect(input().value).toBe('greet');
    key('Escape');
    expect(input().value).toBe('');
  });

  it('focus() focuses the input and selects its text', () => {
    input().value = 'abc';
    fixture.componentInstance.focus();
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(3);
  });
});
