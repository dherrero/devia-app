import {
  ChangeDetectionStrategy, Component, DestroyRef, Injector, afterNextRender, computed, effect, inject, untracked, viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { ButtonComponent, IconComponent, SpinnerComponent, TooltipDirective } from '@devia/ui';
import { LucideNetwork, LucideX } from '@lucide/angular';

import { AppStateService } from '../../core/services/app-state.service';
import { CodeGraphEmptyStateComponent } from './components/empty-state/empty-state.component';
import { GraphCanvasComponent } from './components/graph-canvas/graph-canvas.component';
import { CodeGraphToolbarComponent } from './components/graph-toolbar/graph-toolbar.component';
import { CodeGraphIndexProgressComponent } from './components/index-progress/index-progress.component';
import { CodeGraphStateService } from './services/code-graph-state.service';
import { GraphViewStore } from './services/graph-view.store';

type CodeGraphView =
  | 'no-project' | 'loading' | 'load-error' | 'unsupported'
  | 'none' | 'indexing' | 'graph' | 'error';

/** Code graph screen (S-44), routed full-screen like the Kanban board. */
@Component({
  selector: 'ds-code-graph-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent, IconComponent, SpinnerComponent, TooltipDirective, TranslateModule,
    CodeGraphEmptyStateComponent, CodeGraphIndexProgressComponent, CodeGraphToolbarComponent, GraphCanvasComponent,
  ],
  // Page-level so the explored view survives the canvas being re-created around a re-index.
  providers: [GraphViewStore],
  templateUrl: './code-graph-page.component.html',
  styleUrl: './code-graph-page.component.scss',
})
export default class CodeGraphPageComponent {
  private readonly appState = inject(AppStateService);
  private readonly router = inject(Router);
  readonly graph = inject(CodeGraphStateService);
  private readonly viewStore = inject(GraphViewStore);
  private readonly injector = inject(Injector);

  readonly LucideNetwork = LucideNetwork;
  readonly LucideX = LucideX;

  readonly project = computed(() => this.appState.selectedProject());
  /** The project whose status is shown (lags the selection while a switch loads). */
  readonly graphProject = computed(() => this.graph.project() ?? this.project() ?? '');
  /**
   * Changes when the graph on disk changed: a full index moves `indexedAt`, an
   * incremental (auto-)update only the counts or the commit. The canvas reloads its view.
   */
  readonly revision = computed(() => {
    const s = this.graph.status();
    return s ? `${s.indexedAt ?? ''}|${s.builtAtCommit ?? ''}|${s.nodeCount}|${s.edgeCount}|${s.fileCount}` : undefined;
  });

  private readonly emptyState = viewChild(CodeGraphEmptyStateComponent);
  private readonly progress = viewChild(CodeGraphIndexProgressComponent);
  private previousView: CodeGraphView | null = null;

  readonly view = computed<CodeGraphView>(() => {
    if (!this.project()) return 'no-project';
    if (this.graph.loading()) return 'loading';
    const status = this.graph.status();
    if (!status) return this.graph.error() ? 'load-error' : 'loading';
    // Re-indexing an unsupported project keeps the flag until the job ends: progress wins.
    if (status.state === 'indexing') return 'indexing';
    if (status.unsupported) return 'unsupported';
    if (status.state === 'ready' || status.state === 'stale') return 'graph';
    return status.state;
  });

  constructor() {
    effect(() => {
      const project = this.project();
      untracked(() => {
        this.viewStore.reset();
        void (project ? this.graph.open(project) : this.graph.close());
      });
    });
    effect(() => this.moveFocusOnTransition(this.view()));
    inject(DestroyRef).onDestroy(() => void this.graph.close());
  }

  /**
   * The control that was focused (the index or Reset button) is destroyed when the view switches,
   * which drops focus to <body>: hand it to the new view's primary action, but only if nobody
   * has taken it in the meantime.
   */
  private moveFocusOnTransition(view: CodeGraphView): void {
    const previous = this.previousView;
    this.previousView = view;
    if (previous === null || previous === view) return;
    const target = view === 'indexing' ? this.progress : view === 'none' ? this.emptyState : null;
    if (!target) return;
    afterNextRender(
      () => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        target()?.focusPrimary();
      },
      { injector: this.injector },
    );
  }

  back(): void {
    void this.router.navigateByUrl('/');
  }
}
