import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { ButtonComponent, IconComponent, SpinnerComponent, TooltipDirective } from '@devia/ui';
import { LucideNetwork, LucideX } from '@lucide/angular';

import { AppStateService } from '../../core/services/app-state.service';
import { CodeGraphStateService } from './services/code-graph-state.service';

type CodeGraphView =
  | 'no-project' | 'loading' | 'load-error' | 'unsupported'
  | 'none' | 'indexing' | 'graph' | 'error';

/**
 * Code graph screen (S-44), routed full-screen like the Kanban board. Each body
 * slot is a placeholder that T-509/T-510/T-511 replace with the real content.
 */
@Component({
  selector: 'ds-code-graph-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, SpinnerComponent, TooltipDirective, TranslateModule],
  templateUrl: './code-graph-page.component.html',
  styleUrl: './code-graph-page.component.scss',
})
export default class CodeGraphPageComponent {
  private readonly appState = inject(AppStateService);
  private readonly router = inject(Router);
  readonly graph = inject(CodeGraphStateService);

  readonly LucideNetwork = LucideNetwork;
  readonly LucideX = LucideX;

  readonly project = computed(() => this.appState.selectedProject());

  readonly view = computed<CodeGraphView>(() => {
    if (!this.project()) return 'no-project';
    if (this.graph.loading()) return 'loading';
    const status = this.graph.status();
    if (!status) return this.graph.error() ? 'load-error' : 'loading';
    if (status.unsupported) return 'unsupported';
    if (status.state === 'ready' || status.state === 'stale') return 'graph';
    return status.state;
  });

  constructor() {
    effect(() => {
      const project = this.project();
      untracked(() => void (project ? this.graph.open(project) : this.graph.close()));
    });
    inject(DestroyRef).onDestroy(() => void this.graph.close());
  }

  retry(): void {
    const project = this.project();
    if (project) void this.graph.open(project);
  }

  back(): void {
    void this.router.navigateByUrl('/');
  }
}
