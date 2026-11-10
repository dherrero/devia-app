import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ButtonComponent, IconComponent, ProgressComponent } from '@devia/ui';
import { LucideNetwork, LucideX } from '@lucide/angular';

import { CodeGraphStateService } from '../../services/code-graph-state.service';
import { uiLocale } from '../../utils/locale';
import { CodeGraphActionErrorComponent } from '../action-error/action-error.component';

/**
 * Also shown with no progress at all: the job just started, or another window
 * or process is indexing this project and its events never reach us.
 */
@Component({
  selector: 'ds-cg-index-progress',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, ProgressComponent, TranslateModule, CodeGraphActionErrorComponent],
  templateUrl: './index-progress.component.html',
  styleUrl: './index-progress.component.scss',
})
export class CodeGraphIndexProgressComponent {
  readonly graph = inject(CodeGraphStateService);
  private readonly translate = inject(TranslateService);

  readonly LucideNetwork = LucideNetwork;
  readonly LucideX = LucideX;

  readonly cancelling = signal(false);

  readonly phaseKey = computed(() => {
    const p = this.graph.progress();
    return p ? `codeGraph.progress.phase.${p.phase}` : 'codeGraph.progress.starting';
  });

  /** Null = indeterminate: the file count only measures discover/parse, and is unknown until discovery ends. */
  readonly percent = computed<number | null>(() => {
    const p = this.graph.progress();
    if (!p || p.filesTotal <= 0) return null;
    if (p.phase === 'resolve' || p.phase === 'finalize') return null;
    return Math.min(100, Math.round((p.filesDone / p.filesTotal) * 100));
  });

  format(n: number): string {
    return new Intl.NumberFormat(uiLocale(this.translate)).format(n);
  }

  async cancel(): Promise<void> {
    if (this.cancelling()) return;
    this.cancelling.set(true);
    try {
      await this.graph.cancel();
    } finally {
      this.cancelling.set(false);
    }
  }
}
