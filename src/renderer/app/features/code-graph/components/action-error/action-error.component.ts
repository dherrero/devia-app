import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { AlertComponent, ButtonComponent, IconComponent } from '@devia/ui';
import { LucideX } from '@lucide/angular';

import { CodeGraphStateService } from '../../services/code-graph-state.service';
import { describeCodeGraphError } from '../../utils/code-graph-error';

/** Inline, dismissible report of the last failed code graph action. */
@Component({
  selector: 'ds-cg-action-error',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, ButtonComponent, IconComponent, TranslateModule],
  templateUrl: './action-error.component.html',
  styleUrl: './action-error.component.scss',
})
export class CodeGraphActionErrorComponent {
  readonly graph = inject(CodeGraphStateService);
  readonly LucideX = LucideX;
  readonly view = computed(() => describeCodeGraphError(this.graph.error()));
}
