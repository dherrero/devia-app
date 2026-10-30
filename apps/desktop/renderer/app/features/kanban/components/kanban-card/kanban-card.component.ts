import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { IconComponent, TooltipDirective } from '@devia/ui';
import {
  LucideGitCommitHorizontal, LucideLink, LucideMessageSquare, LucideUsers,
} from '@lucide/angular';

import { cardPriority, priorityLabel } from '../../utils/kanban-filters';
import type { KanbanCardView } from '../../../../../types/devia';

/**
 * One draggable card of the kanban flow columns. The host element IS the
 * card (`.dsk-card`) so the column can attach `cdkDrag` to it directly —
 * the CDK preview/placeholder clones keep this component's host styles.
 */
@Component({
  selector: 'ds-kanban-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TooltipDirective, TranslateModule],
  templateUrl: './kanban-card.component.html',
  styleUrl: './kanban-card.component.scss',
  host: {
    class: 'dsk-card',
    '(click)': 'opened.emit()',
  },
})
export class KanbanCardComponent {
  readonly LucideLink = LucideLink;
  readonly LucideMessageSquare = LucideMessageSquare;
  readonly LucideUsers = LucideUsers;
  readonly LucideGitCommitHorizontal = LucideGitCommitHorizontal;

  readonly card = input.required<KanbanCardView>();
  readonly showSpecTag = input(false);
  readonly specTitle = input('');

  readonly opened = output<void>();

  readonly priority = computed(() => cardPriority(this.card()));
  readonly priorityText = computed(() => priorityLabel(this.priority()));
}
