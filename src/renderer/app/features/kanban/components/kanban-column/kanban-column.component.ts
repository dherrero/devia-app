import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop';
import { TranslateModule } from '@ngx-translate/core';
import { IconComponent, InputComponent } from '@devia/ui';
import { LucideInbox, LucidePlus } from '@lucide/angular';

import { KanbanCardComponent } from '../kanban-card/kanban-card.component';
import type { KanbanCardView, KanbanColumn } from '../../../../../types/devia';

/**
 * One drag-droppable flow column of the kanban board. The host element IS
 * the column (`.dsk-col`); the body is the `cdkDropList` whose data keeps
 * pointing at the parent-owned per-column array (CDK mutates it on drop,
 * optimistically) and whose drop event bubbles up via `dropped`. The
 * quick-add footer keeps its title locally and emits `quickCreated` —
 * open/close exclusivity stays with the parent (`quickAddOpen`).
 */
@Component({
  selector: 'ds-kanban-column',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DragDropModule, FormsModule, IconComponent, InputComponent, TranslateModule,
    KanbanCardComponent,
  ],
  templateUrl: './kanban-column.component.html',
  styleUrl: './kanban-column.component.scss',
  host: { class: 'dsk-col' },
})
export class KanbanColumnComponent {
  readonly LucidePlus = LucidePlus;
  readonly LucideInbox = LucideInbox;

  readonly col = input.required<KanbanColumn>();
  readonly cards = input.required<KanbanCardView[]>();
  readonly dropId = input.required<string>();
  readonly connectedTo = input.required<string[]>();
  readonly specTitles = input.required<Record<string, string | undefined>>();
  readonly showSpecTag = input.required<boolean>();
  readonly quickAddOpen = input.required<boolean>();

  readonly cardOpened = output<KanbanCardView>();
  readonly dropped = output<CdkDragDrop<KanbanCardView[]>>();
  readonly quickCreated = output<string>();
  readonly quickAddStarted = output<void>();
  readonly quickAddCancelled = output<void>();

  quickTitle = '';

  startQuickAdd(): void {
    this.quickTitle = '';
    this.quickAddStarted.emit();
  }
}
