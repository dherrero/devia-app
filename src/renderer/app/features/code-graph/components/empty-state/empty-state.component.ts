import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ButtonComponent, IconComponent } from '@devia/ui';
import { LucideFileQuestion, LucideNetwork, LucideRefreshCw, LucideRotateCcw, LucideTriangleAlert } from '@lucide/angular';

import { CodeGraphStateService } from '../../services/code-graph-state.service';
import { describeCodeGraphError } from '../../utils/code-graph-error';
import { SUPPORTED_LANGUAGE_NAMES } from '../../utils/languages';
import { CodeGraphActionErrorComponent } from '../action-error/action-error.component';

/**
 * `none`: never indexed. `unsupported`: indexed, but no file in a supported language.
 * `failed`: the last index ended in the `error` state. `load-error`: the status itself could not be read.
 */
export type CodeGraphEmptyVariant = 'none' | 'unsupported' | 'failed' | 'load-error';

@Component({
  selector: 'ds-cg-empty-state',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, TranslateModule, CodeGraphActionErrorComponent],
  templateUrl: './empty-state.component.html',
  styleUrl: './empty-state.component.scss',
})
export class CodeGraphEmptyStateComponent {
  readonly graph = inject(CodeGraphStateService);

  readonly variant = input.required<CodeGraphEmptyVariant>();

  readonly LucideNetwork = LucideNetwork;
  readonly LucideFileQuestion = LucideFileQuestion;
  readonly LucideTriangleAlert = LucideTriangleAlert;
  readonly LucideRotateCcw = LucideRotateCcw;
  readonly LucideRefreshCw = LucideRefreshCw;

  readonly languages = SUPPORTED_LANGUAGE_NAMES;

  readonly failure = computed(() => describeCodeGraphError(this.graph.error()));

  index(): void {
    void this.graph.index();
  }

  reload(): void {
    const project = this.graph.project();
    if (project) void this.graph.open(project);
  }
}
