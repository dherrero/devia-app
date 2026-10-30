import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import {
  ButtonComponent, IconComponent, InputComponent, SelectComponent, TooltipDirective,
} from '@devia/ui';
import type { SelectOption } from '@devia/ui';
import { LucideLayoutDashboard, LucidePlus, LucideX } from '@lucide/angular';

import type { KanbanPriorityFilter } from '../../utils/kanban-filters';

/**
 * Toolbar of the kanban board: title + project, the search / priority /
 * spec filters (two-way models owned by the parent), the column/card
 * counters and the "Nueva tarea" + close actions. Pure presentation —
 * option lists and visibility flags come in as inputs.
 */
@Component({
  selector: 'ds-kanban-board-header',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent, IconComponent, InputComponent, SelectComponent,
    TooltipDirective, FormsModule, TranslateModule,
  ],
  templateUrl: './kanban-board-header.component.html',
  styleUrl: './kanban-board-header.component.scss',
  host: { class: 'dsk-head' },
})
export class KanbanBoardHeaderComponent {
  readonly LucideLayoutDashboard = LucideLayoutDashboard;
  readonly LucidePlus = LucidePlus;
  readonly LucideX = LucideX;

  readonly project = input.required<string>();
  readonly isEmpty = input.required<boolean>();
  readonly hasSpecs = input.required<boolean>();
  readonly specFilterOptions = input.required<SelectOption[]>();
  readonly priorityFilterOptions = input.required<SelectOption[]>();
  readonly columnCount = input.required<number>();
  readonly totalCards = input.required<number>();

  readonly search = model('');
  readonly specFilter = model('');
  readonly priorityFilter = model<KanbanPriorityFilter>('all');

  readonly createToggled = output<void>();
  readonly closed = output<void>();
}
