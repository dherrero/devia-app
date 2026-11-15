import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it } from 'vitest';

import en from '../../../../../assets/i18n/en.json';
import es from '../../../../../assets/i18n/es.json';
import type { IndexProgress } from '../../../../../../shared/domain/code-graph';
import { CodeGraphStateService } from '../../services/code-graph-state.service';
import { graphStatus, makeFakeGraphState, type FakeGraphState } from '../../testing/fake-code-graph-state';
import { CodeGraphIndexProgressComponent } from './index-progress.component';

function progress(over: Partial<IndexProgress> = {}): IndexProgress {
  return { phase: 'parse', filesDone: 3, filesTotal: 12, nodes: 1234, edges: 5678, ...over };
}

describe('CodeGraphIndexProgressComponent', () => {
  let fixture: ComponentFixture<CodeGraphIndexProgressComponent>;
  let graph: FakeGraphState;

  beforeEach(async () => {
    graph = makeFakeGraphState();
    graph.status.set(graphStatus({ state: 'indexing' }));
    graph.busy.set(true);
    await TestBed.configureTestingModule({
      imports: [CodeGraphIndexProgressComponent, TranslateModule.forRoot()],
      providers: [{ provide: CodeGraphStateService, useValue: graph }],
    }).compileComponents();
    TestBed.inject(TranslateService).use('es');
    fixture = TestBed.createComponent(CodeGraphIndexProgressComponent);
    fixture.detectChanges();
  });

  const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const bar = (): HTMLElement | null => host().querySelector('[role="progressbar"]');
  const cancel = (): HTMLButtonElement | null =>
    host().querySelector<HTMLButtonElement>('[data-testid="cg-cancel"] button');

  it('with no progress yet shows an indeterminate bar and the starting label', () => {
    expect(host().textContent).toContain('codeGraph.progress.starting');
    expect(bar()?.getAttribute('aria-valuenow')).toBeNull();
    expect(bar()?.getAttribute('aria-label')).toBe('codeGraph.progress.aria');
    expect(host().querySelector('[data-testid="cg-index"]')).toBeNull();
  });

  it('shows the translated phase, a determinate bar and the counters', () => {
    graph.progress.set(progress());
    fixture.detectChanges();
    expect(host().textContent).toContain('codeGraph.progress.phase.parse');
    const el = bar();
    expect(el?.getAttribute('aria-valuemin')).toBe('0');
    expect(el?.getAttribute('aria-valuemax')).toBe('100');
    expect(el?.getAttribute('aria-valuenow')).toBe('25');
    const counters = host().querySelector('[data-testid="cg-progress-counters"]')?.textContent ?? '';
    expect(counters).toContain(new Intl.NumberFormat('es').format(1234));
    expect(counters).toContain(new Intl.NumberFormat('es').format(5678));
  });

  it.each(['resolve', 'finalize'] as const)('is indeterminate during %s', (phase) => {
    graph.progress.set(progress({ phase, filesDone: 12, filesTotal: 12 }));
    fixture.detectChanges();
    expect(host().textContent).toContain(`codeGraph.progress.phase.${phase}`);
    expect(bar()?.getAttribute('aria-valuenow')).toBeNull();
  });

  it('is indeterminate while the total is still unknown', () => {
    graph.progress.set(progress({ phase: 'discover', filesDone: 0, filesTotal: 0 }));
    fixture.detectChanges();
    expect(bar()?.getAttribute('aria-valuenow')).toBeNull();
  });

  it('cancel calls the state and is disabled while the cancellation is in flight', async () => {
    let settle: () => void = () => undefined;
    graph.cancel.mockImplementationOnce(() => new Promise<void>((resolve) => (settle = resolve)));
    cancel()?.click();
    fixture.detectChanges();
    expect(graph.cancel).toHaveBeenCalledTimes(1);
    expect(cancel()?.disabled).toBe(true);
    settle();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(cancel()?.disabled).toBe(false);
  });

  it('cancel stays available while the index job keeps the state busy', () => {
    expect(cancel()?.disabled).toBe(false);
  });

  describe('a11y placement', () => {
    it('aria-live is on the phase label only, not on the whole section', () => {
      graph.progress.set(progress());
      fixture.detectChanges();
      const live = Array.from(host().querySelectorAll('[aria-live]'));
      expect(live).toHaveLength(1);
      expect(live[0]?.getAttribute('data-testid')).toBe('cg-progress-phase');
      expect(live[0]?.getAttribute('aria-live')).toBe('polite');
      expect(host().querySelector('[data-testid="cg-progress"]')?.hasAttribute('aria-live')).toBe(false);
    });
  });

  describe('plural file count (real es/en translations)', () => {
    const load = (lang: 'es' | 'en'): void => {
      const json: Record<string, unknown> = lang === 'es' ? es : en;
      const t = TestBed.inject(TranslateService);
      t.setTranslation(lang, json);
      t.use(lang);
    };
    const meta = (): string => (host().querySelector('.cg-progress__meta')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const counters = (): string => (host().querySelector('[data-testid="cg-progress-counters"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();

    it.each([
      ['es', 1, '0 de 1 fichero'],
      ['es', 2, '0 de 2 ficheros'],
      ['es', 1000, `0 de ${new Intl.NumberFormat('es').format(1000)} ficheros`],
      ['en', 1, '0 of 1 file'],
      ['en', 2, '0 of 2 files'],
      ['en', 1000, '0 of 1,000 files'],
    ] as const)('%s with %i total file(s)', (lang, total, expected) => {
      load(lang);
      graph.progress.set(progress({ filesDone: 0, filesTotal: total }));
      fixture.detectChanges();
      expect(meta()).toContain(expected);
    });

    it.each([
      ['es', 1, 'nodo1arista1'],
      ['es', 0, 'nodos0aristas0'],
      ['es', 2, 'nodos2aristas2'],
      ['en', 1, 'node1edge1'],
      ['en', 0, 'nodes0edges0'],
      ['en', 2, 'nodes2edges2'],
    ] as const)('%s counters with %i node(s) and edge(s)', (lang, n, expected) => {
      load(lang);
      graph.progress.set(progress({ nodes: n, edges: n }));
      fixture.detectChanges();
      expect(counters()).toContain(expected);
    });
  });
});
