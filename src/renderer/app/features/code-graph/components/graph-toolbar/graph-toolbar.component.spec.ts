import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { DialogService } from '@devia/ui';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../../assets/i18n/en.json';
import es from '../../../../../assets/i18n/es.json';
import type { CodeGraphStatus } from '../../../../../../shared/domain/code-graph';
import { CodeGraphStateService } from '../../services/code-graph-state.service';
import { graphStatus, makeFakeGraphState, type FakeGraphState } from '../../testing/fake-code-graph-state';
import { CodeGraphToolbarComponent } from './graph-toolbar.component';

const READY: Partial<CodeGraphStatus> = {
  state: 'ready',
  nodeCount: 12345,
  edgeCount: 67890,
  fileCount: 321,
  languages: { typescript: 300, python: 21 },
  indexedAt: Date.now() - 5 * 60_000,
};

describe('CodeGraphToolbarComponent', () => {
  let fixture: ComponentFixture<CodeGraphToolbarComponent>;
  let graph: FakeGraphState;
  let confirm: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    graph = makeFakeGraphState();
    graph.status.set(graphStatus(READY));
    confirm = vi.fn(() => of(true));
    await TestBed.configureTestingModule({
      imports: [CodeGraphToolbarComponent, TranslateModule.forRoot()],
      providers: [
        { provide: CodeGraphStateService, useValue: graph },
        { provide: DialogService, useValue: { confirm } },
      ],
    }).compileComponents();
    TestBed.inject(TranslateService).use('es');
    fixture = TestBed.createComponent(CodeGraphToolbarComponent);
    fixture.detectChanges();
  });

  const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = (id: string): HTMLElement | null => host().querySelector(`[data-testid="${id}"]`);
  const button = (id: string): HTMLButtonElement | null =>
    host().querySelector<HTMLButtonElement>(`[data-testid="${id}"] button`);
  const setStatus = (over: Partial<CodeGraphStatus>): void => {
    graph.status.set(graphStatus({ ...READY, ...over }));
    fixture.detectChanges();
  };

  it('ready: shows the up-to-date chip and a secondary update button', () => {
    expect(byId('cg-status-chip')?.textContent).toContain('codeGraph.toolbar.up_to_date');
    expect(byId('cg-stale-reason')).toBeNull();
    expect(button('cg-update')?.className).not.toContain('dv-button--primary');
  });

  it.each(['commit', 'config', 'dirty'] as const)('stale by %s: chip, reason text and a primary update button together', (reason) => {
    setStatus({ state: 'stale', staleReason: reason });
    expect(byId('cg-status-chip')?.textContent).toContain('codeGraph.toolbar.stale');
    expect(byId('cg-stale-reason')?.textContent).toContain(`codeGraph.toolbar.stale_reason.${reason}`);
    expect(button('cg-update')?.className).toContain('dv-button--primary');
  });

  it('shows how many calls the agents made, and a warning chip when they made none (S-48)', () => {
    expect(graph.refreshUsage).toHaveBeenCalled();
    expect(byId('cg-usage')).toBeNull();
    graph.usage.set({ total: 1234, byTool: { graph_explore: 1000, graph_node: 234 }, byAgent: { claude: 1234 }, lastAt: Date.now() });
    fixture.detectChanges();
    expect(byId('cg-usage')?.textContent).toContain('usage_calls');
    graph.usage.set({ total: 0, byTool: {}, byAgent: {}, lastAt: null });
    fixture.detectChanges();
    expect(byId('cg-usage')?.textContent).toContain('usage_none');
    expect(byId('cg-usage')?.classList.contains('cg-toolbar__usage--none')).toBe(true);
  });

  it('says so when the graph is switched off for agents (S-48)', () => {
    setStatus({ agentAccess: false });
    graph.usage.set({ total: 0, byTool: {}, byAgent: {}, lastAt: null });
    fixture.detectChanges();
    expect(byId('cg-usage')?.textContent).toContain('usage_off');
  });

  it('the update button updates the graph', () => {
    button('cg-update')?.click();
    expect(graph.update).toHaveBeenCalledTimes(1);
  });

  it('shows the counts in the current locale, the detected languages and the indexed time', () => {
    const fmt = new Intl.NumberFormat('es');
    const stats = byId('cg-stats')?.textContent ?? '';
    expect(stats).toContain(fmt.format(12345));
    expect(stats).toContain(fmt.format(67890));
    expect(stats).toContain(fmt.format(321));
    const languages = byId('cg-languages')?.textContent ?? '';
    expect(languages).toContain('TypeScript');
    expect(languages).toContain('Python');
    expect(languages.indexOf('TypeScript')).toBeLessThan(languages.indexOf('Python'));
    const time = byId('cg-indexed-at');
    expect(time?.textContent).toContain('codeGraph.toolbar.indexed_at');
    expect(time?.getAttribute('datetime')).toBe(new Date(READY.indexedAt ?? 0).toISOString());
  });

  it('a graph indexed seconds ago reads as "now", not as "this minute"', () => {
    setStatus({ indexedAt: Date.now() - 10_000 });
    const now = new Intl.RelativeTimeFormat('es', { numeric: 'auto' }).format(0, 'second');
    expect(fixture.componentInstance.relativeTime(Date.now() - 10_000)).toBe(now);
  });

  it('the agent access switch reflects the status and turns it off', () => {
    const sw = button('cg-agent-access');
    expect(sw?.getAttribute('role')).toBe('switch');
    expect(sw?.getAttribute('aria-checked')).toBe('true');
    expect(sw?.getAttribute('aria-label')).toBe('codeGraph.toolbar.agent_access');
    sw?.click();
    expect(graph.setAgentAccess).toHaveBeenCalledWith(false);
  });

  it('the auto-update switch reflects the status and turns it off', () => {
    const sw = button('cg-auto-update');
    expect(sw?.getAttribute('aria-checked')).toBe('true');
    expect(sw?.getAttribute('aria-label')).toBe('codeGraph.toolbar.auto_update');
    sw?.click();
    expect(graph.setAutoUpdate).toHaveBeenCalledWith(false);
  });

  it('a switch whose action failed snaps back to the real status', async () => {
    button('cg-agent-access')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(button('cg-agent-access')?.getAttribute('aria-checked')).toBe('true');
  });

  it('a switch follows a status change pushed from main', () => {
    setStatus({ autoUpdate: false });
    expect(button('cg-auto-update')?.getAttribute('aria-checked')).toBe('false');
  });

  it('reset asks for confirmation and does nothing when declined', async () => {
    confirm.mockReturnValueOnce(of(false));
    button('cg-reset')?.click();
    await fixture.whenStable();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ danger: true, title: 'codeGraph.reset_dialog.title' });
    expect(graph.reset).not.toHaveBeenCalled();
  });

  it('reset runs once confirmed', async () => {
    button('cg-reset')?.click();
    await fixture.whenStable();
    expect(graph.reset).toHaveBeenCalledTimes(1);
  });

  it('every control is disabled while busy', () => {
    graph.busy.set(true);
    fixture.detectChanges();
    for (const id of ['cg-update', 'cg-agent-access', 'cg-auto-update', 'cg-reset']) {
      expect(button(id)?.disabled, id).toBe(true);
    }
  });

  it('every control has an accessible name', () => {
    for (const id of ['cg-update', 'cg-agent-access', 'cg-auto-update', 'cg-reset']) {
      const el = button(id);
      const name = el?.getAttribute('aria-label') ?? el?.textContent?.trim() ?? '';
      expect(name.length, id).toBeGreaterThan(0);
    }
  });

  it('warns when the watcher is degraded or unavailable, and only then', () => {
    expect(byId('cg-watch-warning')).toBeNull();
    setStatus({ watchDegraded: true });
    expect(byId('cg-watch-warning')?.textContent).toContain('codeGraph.toolbar.watch_unavailable');
    setStatus({ watchDegraded: false });
    graph.watchUnavailable.set(true);
    fixture.detectChanges();
    expect(byId('cg-watch-warning')).not.toBeNull();
  });

  it('shows an action failure inline and dismisses it', () => {
    graph.error.set("Error invoking remote method 'code-graph:update': Error: Code graph operation failed");
    fixture.detectChanges();
    expect(byId('cg-action-error')?.textContent).toContain('codeGraph.errors.action');
    button('cg-dismiss-error')?.click();
    expect(graph.dismissError).toHaveBeenCalledTimes(1);
  });

  describe('relative time', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function mountAt(indexedAt: number): ComponentFixture<CodeGraphToolbarComponent> {
      graph.status.set(graphStatus({ ...READY, indexedAt }));
      const f = TestBed.createComponent(CodeGraphToolbarComponent);
      f.detectChanges();
      return f;
    }
    const timeText = (f: ComponentFixture<CodeGraphToolbarComponent>): string =>
      (f.nativeElement as HTMLElement).querySelector('[data-testid="cg-indexed-at"]')?.textContent ?? '';

    it('ticks about once a minute: "now" becomes "1 minute ago" with no other change', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
      TestBed.inject(TranslateService).setTranslation('es', { codeGraph: { toolbar: { indexed_at: 'Indexado {{time}}' } } });
      const f = mountAt(Date.now());
      const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
      expect(timeText(f)).toContain(rtf.format(0, 'second'));
      vi.advanceTimersByTime(61_000);
      f.detectChanges();
      expect(timeText(f)).toContain(rtf.format(-1, 'minute'));
      f.destroy();
    });

    it('does not tick every second', () => {
      vi.useFakeTimers();
      const f = mountAt(Date.now());
      expect(vi.getTimerCount()).toBe(1);
      const spy = vi.spyOn(f.componentInstance, 'relativeTime');
      f.detectChanges();
      spy.mockClear();
      vi.advanceTimersByTime(30_000);
      f.detectChanges();
      expect(spy).not.toHaveBeenCalled();
      f.destroy();
    });

    it('a future indexedAt (clock skew) clamps to "now"', () => {
      vi.useFakeTimers();
      const f = mountAt(Date.now() + 3_600_000);
      const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
      expect(f.componentInstance.relativeTime(Date.now() + 3_600_000)).toBe(rtf.format(0, 'second'));
      f.destroy();
    });

    it('clears the timer when destroyed', () => {
      vi.useFakeTimers();
      const setSpy = vi.spyOn(globalThis, 'setInterval');
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      const f = mountAt(Date.now());
      const id = setSpy.mock.results[0]?.value as unknown;
      expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      expect(clearSpy).not.toHaveBeenCalledWith(id);
      f.destroy();
      expect(clearSpy).toHaveBeenCalledWith(id);
    });
  });

  describe('plural counts (real es/en translations)', () => {
    const load = (lang: 'es' | 'en'): void => {
      const json: Record<string, unknown> = lang === 'es' ? es : en;
      const t = TestBed.inject(TranslateService);
      t.setTranslation(lang, json);
      t.use(lang);
    };
    const stats = (): string => (byId('cg-stats')?.textContent ?? '').replace(/\s*·\s*/g, ' · ').replace(/\s+/g, ' ');

    it.each([
      ['es', 1, '1 nodo · 1 arista · 1 fichero'],
      ['es', 0, '0 nodos · 0 aristas · 0 ficheros'],
      ['es', 2, '2 nodos · 2 aristas · 2 ficheros'],
      ['es', 1000, `${new Intl.NumberFormat('es').format(1000)} nodos · ${new Intl.NumberFormat('es').format(1000)} aristas · ${new Intl.NumberFormat('es').format(1000)} ficheros`],
      ['en', 1, '1 node · 1 edge · 1 file'],
      ['en', 0, '0 nodes · 0 edges · 0 files'],
      ['en', 2, '2 nodes · 2 edges · 2 files'],
      ['en', 1000, '1,000 nodes · 1,000 edges · 1,000 files'],
    ] as const)('%s with %i of each', (lang, n, expected) => {
      load(lang);
      setStatus({ nodeCount: n, edgeCount: n, fileCount: n });
      expect(stats().trim()).toBe(expected);
    });
  });
});
