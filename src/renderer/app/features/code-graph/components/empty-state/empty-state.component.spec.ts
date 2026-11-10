import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { CodeGraphStateService } from '../../services/code-graph-state.service';
import { graphStatus, makeFakeGraphState, type FakeGraphState } from '../../testing/fake-code-graph-state';
import { CodeGraphEmptyStateComponent, type CodeGraphEmptyVariant } from './empty-state.component';

describe('CodeGraphEmptyStateComponent', () => {
  let fixture: ComponentFixture<CodeGraphEmptyStateComponent>;
  let graph: FakeGraphState;

  async function render(variant: CodeGraphEmptyVariant): Promise<void> {
    graph = makeFakeGraphState();
    await TestBed.configureTestingModule({
      imports: [CodeGraphEmptyStateComponent, TranslateModule.forRoot()],
      providers: [{ provide: CodeGraphStateService, useValue: graph }],
    }).compileComponents();
    fixture = TestBed.createComponent(CodeGraphEmptyStateComponent);
    fixture.componentRef.setInput('variant', variant);
    fixture.detectChanges();
  }

  const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const button = (id: string): HTMLButtonElement | null =>
    host().querySelector<HTMLButtonElement>(`[data-testid="${id}"] button`);

  describe('none', () => {
    beforeEach(() => render('none'));

    it('explains indexing and offers the index button', () => {
      const text = host().textContent ?? '';
      expect(text).toContain('codeGraph.empty.title');
      expect(text).toContain('codeGraph.empty.body');
      expect(text).toContain('codeGraph.empty.languages');
      expect(button('cg-index')?.textContent).toContain('codeGraph.empty.index');
    });

    it('clicking the button indexes the project', () => {
      button('cg-index')?.click();
      expect(graph.index).toHaveBeenCalledTimes(1);
    });

    it('the button is disabled while busy', () => {
      graph.busy.set(true);
      fixture.detectChanges();
      expect(button('cg-index')?.disabled).toBe(true);
      button('cg-index')?.click();
      expect(graph.index).not.toHaveBeenCalled();
    });

    it('shows a failed index action and lets the user dismiss it', () => {
      graph.status.set(graphStatus());
      graph.error.set('CODE_GRAPH_NOT_CREATED');
      fixture.detectChanges();
      const alert = host().querySelector('[data-testid="cg-action-error"]');
      expect(alert?.textContent).toContain('codeGraph.errors.not_created');
      expect(alert?.textContent).not.toContain('CODE_GRAPH_NOT_CREATED');
      button('cg-dismiss-error')?.click();
      expect(graph.dismissError).toHaveBeenCalledTimes(1);
    });
  });

  describe('unsupported', () => {
    beforeEach(() => render('unsupported'));

    it('says the project has no supported code and offers a re-index, not the first index', () => {
      expect(host().textContent).toContain('codeGraph.unsupported.body');
      expect(button('cg-index')).toBeNull();
      button('cg-reindex')?.click();
      expect(graph.index).toHaveBeenCalledTimes(1);
    });

    it('the re-index button is disabled while busy', () => {
      graph.busy.set(true);
      fixture.detectChanges();
      expect(button('cg-reindex')?.disabled).toBe(true);
    });
  });

  describe('failed', () => {
    beforeEach(() => render('failed'));

    it('shows the failure, a retry that re-indexes and a reload that re-reads the state', () => {
      expect(host().textContent).toContain('codeGraph.failed.title');
      button('cg-retry-index')?.click();
      expect(graph.index).toHaveBeenCalledTimes(1);
      expect(graph.open).not.toHaveBeenCalled();
      button('cg-reload')?.click();
      expect(graph.open).toHaveBeenCalledWith('proj-a');
    });

    it('shows the error message from the state', () => {
      graph.error.set("Error invoking remote method 'code-graph:index': Error: Workspace not configured");
      fixture.detectChanges();
      const text = host().textContent ?? '';
      expect(text).toContain('Workspace not configured');
      expect(text).not.toContain('Error invoking remote method');
    });
  });

  describe('load-error', () => {
    beforeEach(() => render('load-error'));

    it('shows the load failure with a retry that opens the project again', () => {
      graph.error.set("Error invoking remote method 'code-graph:status': Error: Code graph operation failed");
      fixture.detectChanges();
      expect(host().textContent).toContain('codeGraph.state.error');
      expect(host().textContent).toContain('codeGraph.errors.action');
      expect(button('cg-retry-index')).toBeNull();
      button('cg-retry')?.click();
      expect(graph.open).toHaveBeenCalledWith('proj-a');
    });
  });
});
