import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodeGraphStatus } from '../../../../shared/domain/code-graph';
import { AppStateService } from '../../core/services/app-state.service';
import CodeGraphPageComponent from './code-graph-page.component';
import { CodeGraphStateService } from './services/code-graph-state.service';

function status(over: Partial<CodeGraphStatus> = {}): CodeGraphStatus {
  return {
    state: 'none',
    nodeCount: 0,
    edgeCount: 0,
    fileCount: 0,
    languages: {},
    agentAccess: false,
    autoUpdate: false,
    ...over,
  };
}

function makeGraphState() {
  return {
    status: signal<CodeGraphStatus | null>(null),
    loading: signal(false),
    error: signal<string | null>(null),
    open: vi.fn<(p: string) => Promise<void>>(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
}

describe('CodeGraphPageComponent (S-44 T-506)', () => {
  let fixture: ComponentFixture<CodeGraphPageComponent>;
  let graph: ReturnType<typeof makeGraphState>;
  const selectedProject = signal<string | null>('proj-a');
  const navigateByUrl = vi.fn(() => Promise.resolve(true));

  beforeEach(async () => {
    graph = makeGraphState();
    selectedProject.set('proj-a');
    navigateByUrl.mockClear();
    await TestBed.configureTestingModule({
      imports: [CodeGraphPageComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: { selectedProject } },
        { provide: CodeGraphStateService, useValue: graph },
        { provide: Router, useValue: { navigateByUrl } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(CodeGraphPageComponent);
    fixture.detectChanges();
  });

  const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const slot = (id: string): HTMLElement | null => host().querySelector(`[data-testid="${id}"]`);

  it('opens the selected project on init', () => {
    expect(graph.open).toHaveBeenCalledTimes(1);
    expect(graph.open).toHaveBeenCalledWith('proj-a');
  });

  it('re-opens when the selected project changes', () => {
    selectedProject.set('proj-b');
    fixture.detectChanges();
    expect(graph.open).toHaveBeenLastCalledWith('proj-b');
    expect(graph.open).toHaveBeenCalledTimes(2);
  });

  it('closes the graph state on destroy', () => {
    fixture.destroy();
    expect(graph.close).toHaveBeenCalledTimes(1);
  });

  it('shows the select-project message and closes when no project is selected', () => {
    selectedProject.set(null);
    fixture.detectChanges();
    expect(slot('cg-no-project')?.textContent).toContain('empty_state.select_project');
    expect(graph.close).toHaveBeenCalled();
  });

  it('shows the loading state during the first status fetch', () => {
    graph.loading.set(true);
    fixture.detectChanges();
    expect(slot('cg-loading')).not.toBeNull();
  });

  it.each([
    ['none', 'cg-empty-slot'],
    ['indexing', 'cg-progress-slot'],
    ['ready', 'cg-graph-slot'],
    ['stale', 'cg-graph-slot'],
    ['error', 'cg-error-slot'],
  ] as const)('renders the slot for state %s', (state, testId) => {
    graph.status.set(status({ state }));
    fixture.detectChanges();
    expect(slot(testId)?.textContent).toContain(state);
    expect(host().querySelectorAll('section[data-testid]').length).toBe(1);
  });

  it('renders the unsupported slot when the project is unsupported', () => {
    graph.status.set(status({ unsupported: true }));
    fixture.detectChanges();
    expect(slot('cg-unsupported-slot')).not.toBeNull();
    expect(slot('cg-empty-slot')).toBeNull();
  });

  it('a failed first load shows the error slot with the message and a retry that opens again', () => {
    graph.error.set('Code graph operation failed');
    fixture.detectChanges();
    const errorSlot = slot('cg-error-slot');
    expect(errorSlot?.textContent).toContain('Code graph operation failed');
    const retry = errorSlot?.querySelector<HTMLButtonElement>('[data-testid="cg-retry"] button');
    retry?.click();
    expect(graph.open).toHaveBeenCalledTimes(2);
    expect(graph.open).toHaveBeenLastCalledWith('proj-a');
  });

  it('the back button navigates to /', () => {
    host().querySelector<HTMLButtonElement>('[data-testid="cg-back"] button')?.click();
    expect(navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('shows the title in the header', () => {
    expect(host().querySelector('header')?.textContent).toContain('codeGraph.title');
  });
});
