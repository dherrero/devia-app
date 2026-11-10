import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { DialogService } from '@devia/ui';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodeGraphProgressPayload, CodeGraphStatusChangedPayload } from '../../../../shared/contracts/events';
import type { CodeGraphStatus } from '../../../../shared/domain/code-graph';
import { AppStateService } from '../../core/services/app-state.service';
import { ElectronApiService } from '../../core/services/electron-api.service';
import CodeGraphPageComponent from './code-graph-page.component';
import { CodeGraphStateService } from './services/code-graph-state.service';
import { graphStatus } from './testing/fake-code-graph-state';

function makeApi() {
  const progressListeners = new Set<(e: CodeGraphProgressPayload) => void>();
  const statusListeners = new Set<(e: CodeGraphStatusChangedPayload) => void>();
  return {
    emitProgress: (e: CodeGraphProgressPayload) => progressListeners.forEach((cb) => cb(e)),
    emitStatus: (e: CodeGraphStatusChangedPayload) => statusListeners.forEach((cb) => cb(e)),
    codeGraphStatus: vi.fn<(p: string) => Promise<CodeGraphStatus>>(() => Promise.resolve(graphStatus())),
    codeGraphIndex: vi.fn<(p: string) => Promise<CodeGraphStatus>>(() => Promise.resolve(graphStatus({ state: 'ready' }))),
    codeGraphUpdate: vi.fn<(p: string) => Promise<CodeGraphStatus>>(() => Promise.resolve(graphStatus({ state: 'ready' }))),
    codeGraphCancel: vi.fn<(p: string) => Promise<void>>(() => Promise.resolve()),
    codeGraphReset: vi.fn<(p: string) => Promise<void>>(() => Promise.resolve()),
    codeGraphSetAgentAccess: vi.fn<(p: string, on: boolean) => Promise<void>>(() => Promise.resolve()),
    codeGraphSetAutoUpdate: vi.fn<(p: string, on: boolean) => Promise<void>>(() => Promise.resolve()),
    codeGraphWatch: vi.fn<(p: string) => Promise<void>>(() => Promise.resolve()),
    codeGraphUnwatch: vi.fn<(p: string) => Promise<void>>(() => Promise.resolve()),
    onCodeGraphProgress: vi.fn((cb: (e: CodeGraphProgressPayload) => void) => {
      progressListeners.add(cb);
      return () => progressListeners.delete(cb);
    }),
    onCodeGraphStatusChanged: vi.fn((cb: (e: CodeGraphStatusChangedPayload) => void) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    }),
  };
}

describe('CodeGraphPageComponent', () => {
  let fixture: ComponentFixture<CodeGraphPageComponent>;
  let api: ReturnType<typeof makeApi>;
  let graph: CodeGraphStateService;
  const selectedProject = signal<string | null>('proj-a');
  const navigateByUrl = vi.fn(() => Promise.resolve(true));

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function mount(initial: CodeGraphStatus | Error): Promise<void> {
    if (initial instanceof Error) api.codeGraphStatus.mockRejectedValueOnce(initial);
    else api.codeGraphStatus.mockResolvedValueOnce(initial);
    fixture = TestBed.createComponent(CodeGraphPageComponent);
    fixture.detectChanges();
    await settle();
  }

  beforeEach(async () => {
    api = makeApi();
    selectedProject.set('proj-a');
    navigateByUrl.mockClear();
    await TestBed.configureTestingModule({
      imports: [CodeGraphPageComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: { selectedProject } },
        { provide: ElectronApiService, useValue: api },
        { provide: DialogService, useValue: { confirm: vi.fn(() => of(true)) } },
        { provide: Router, useValue: { navigateByUrl } },
      ],
    }).compileComponents();
    graph = TestBed.inject(CodeGraphStateService);
  });

  const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = (id: string): HTMLElement | null => host().querySelector(`[data-testid="${id}"]`);
  const button = (id: string): HTMLButtonElement | null =>
    host().querySelector<HTMLButtonElement>(`[data-testid="${id}"] button`);

  it('opens the selected project on init and re-opens on project change', async () => {
    await mount(graphStatus());
    expect(api.codeGraphStatus).toHaveBeenCalledWith('proj-a');
    selectedProject.set('proj-b');
    fixture.detectChanges();
    await settle();
    expect(api.codeGraphStatus).toHaveBeenLastCalledWith('proj-b');
  });

  it('stops watching the project on destroy', async () => {
    await mount(graphStatus());
    fixture.destroy();
    expect(api.codeGraphUnwatch).toHaveBeenCalledWith('proj-a');
  });

  it('shows the select-project message when no project is selected', async () => {
    selectedProject.set(null);
    await mount(graphStatus());
    expect(byId('cg-no-project')?.textContent).toContain('empty_state.select_project');
  });

  it('none: renders the empty state whose button indexes the project', async () => {
    await mount(graphStatus());
    expect(host().querySelector('ds-cg-empty-state')).not.toBeNull();
    button('cg-index')?.click();
    expect(api.codeGraphIndex).toHaveBeenCalledWith('proj-a');
  });

  it('indexing: renders the progress view with the pushed progress', async () => {
    await mount(graphStatus({ state: 'indexing' }));
    api.emitProgress({ project: 'proj-a', progress: { phase: 'parse', filesDone: 5, filesTotal: 10, nodes: 1, edges: 2 } });
    fixture.detectChanges();
    expect(host().querySelector('ds-cg-index-progress')).not.toBeNull();
    expect(host().querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    expect(button('cg-index')).toBeNull();
  });

  it('clicking index switches to the progress view while the job runs', async () => {
    await mount(graphStatus());
    api.codeGraphIndex.mockReturnValueOnce(new Promise<CodeGraphStatus>(() => undefined));
    button('cg-index')?.click();
    fixture.detectChanges();
    expect(host().querySelector('ds-cg-index-progress')).not.toBeNull();
  });

  it.each(['ready', 'stale'] as const)('%s: mounts the toolbar above the graph slot', async (state) => {
    await mount(graphStatus({ state }));
    const toolbar = host().querySelector('ds-cg-toolbar');
    const slotEl = byId('cg-graph-slot');
    expect(toolbar).not.toBeNull();
    expect(slotEl).not.toBeNull();
    expect(toolbar?.compareDocumentPosition(slotEl as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('unsupported: renders the unsupported variant with no toolbar', async () => {
    await mount(graphStatus({ state: 'ready', unsupported: true }));
    expect(host().textContent).toContain('codeGraph.unsupported.body');
    expect(host().querySelector('ds-cg-toolbar')).toBeNull();
    expect(byId('cg-graph-slot')).toBeNull();
  });

  it('re-indexing an unsupported project shows the progress view', async () => {
    await mount(graphStatus({ state: 'ready', unsupported: true }));
    api.codeGraphIndex.mockReturnValueOnce(new Promise<CodeGraphStatus>(() => undefined));
    button('cg-reindex')?.click();
    fixture.detectChanges();
    expect(host().querySelector('ds-cg-index-progress')).not.toBeNull();
  });

  it('error: the retry re-indexes the project', async () => {
    await mount(graphStatus({ state: 'error' }));
    button('cg-retry-index')?.click();
    expect(api.codeGraphIndex).toHaveBeenCalledWith('proj-a');
  });

  it('a failed first load shows the error with a retry that opens again', async () => {
    await mount(new Error("Error invoking remote method 'code-graph:status': Error: Code graph operation failed"));
    expect(host().textContent).toContain('codeGraph.state.error');
    expect(host().textContent).not.toContain('Error invoking remote method');
    button('cg-retry')?.click();
    await settle();
    expect(api.codeGraphStatus).toHaveBeenCalledTimes(2);
  });

  it('an action failure with an existing status is displayed near the toolbar', async () => {
    await mount(graphStatus({ state: 'ready' }));
    api.codeGraphSetAgentAccess.mockRejectedValueOnce(
      new Error("Error invoking remote method 'code-graph:set-agent-access': Error: CODE_GRAPH_NOT_CREATED"),
    );
    button('cg-agent-access')?.click();
    await settle();
    expect(graph.error()).toBe('CODE_GRAPH_NOT_CREATED');
    expect(byId('cg-action-error')?.textContent).toContain('codeGraph.errors.not_created');
  });

  it.each([
    graphStatus(),
    graphStatus({ state: 'indexing' }),
    graphStatus({ state: 'ready' }),
    graphStatus({ state: 'stale', staleReason: 'dirty' }),
    graphStatus({ state: 'error' }),
    graphStatus({ state: 'ready', unsupported: true }),
  ])('never prints raw state text (%o)', async (s) => {
    await mount(s);
    expect(host().querySelector('.cg-raw')).toBeNull();
    expect(host().querySelector('code')).toBeNull();
  });

  it('the back button navigates to /', async () => {
    await mount(graphStatus());
    button('cg-back')?.click();
    expect(navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('shows the title in the header', async () => {
    await mount(graphStatus());
    expect(host().querySelector('header')?.textContent).toContain('codeGraph.title');
  });

  describe('focus', () => {
    const attach = (): void => {
      document.body.appendChild(host());
    };
    afterEach(() => {
      host().remove();
    });

    it('moves focus to the Cancel button when indexing starts and the index button disappears', async () => {
      await mount(graphStatus());
      attach();
      api.codeGraphIndex.mockReturnValueOnce(new Promise<CodeGraphStatus>(() => undefined));
      button('cg-index')?.focus();
      expect(document.activeElement).toBe(button('cg-index'));
      button('cg-index')?.click();
      await settle();
      expect(button('cg-index')).toBeNull();
      expect(document.activeElement).toBe(button('cg-cancel'));
    });

    it('moves focus to the primary button of the empty state after a confirmed reset', async () => {
      await mount(graphStatus({ state: 'ready', nodeCount: 3 }));
      attach();
      api.codeGraphStatus.mockResolvedValueOnce(graphStatus({ state: 'none' }));
      button('cg-reset')?.focus();
      button('cg-reset')?.click();
      await settle();
      await settle();
      expect(byId('cg-empty')).not.toBeNull();
      expect(document.activeElement).toBe(button('cg-index'));
    });

    it('does not steal focus the user has already placed elsewhere', async () => {
      await mount(graphStatus());
      attach();
      const other = document.createElement('input');
      document.body.appendChild(other);
      api.codeGraphIndex.mockReturnValueOnce(new Promise<CodeGraphStatus>(() => undefined));
      button('cg-index')?.click();
      other.focus();
      await settle();
      expect(document.activeElement).toBe(other);
      other.remove();
    });

    it('does not move focus on the first render', async () => {
      await mount(graphStatus());
      attach();
      expect(document.activeElement).toBe(document.body);
    });
  });
});
