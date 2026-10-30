import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  booleanAttribute,
} from '@angular/core';
import {
  CdkDropList,
  CdkDrag,
  CdkDragDrop,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import {
  KanbanColumn,
  KanbanItem,
  KanbanMoveEvent,
  KanbanInlineCardEvent,
  KanbanColMenuEvent,
  KanbanColumnMoveEvent,
} from '../kanban.models';
import { KanbanColumnComponent } from '../kanban-column';

@Component({
  selector: 'dv-kanban-board',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDropList, CdkDrag, KanbanColumnComponent],
  host: { class: 'dv-kanban-board' },
})
export class KanbanBoardComponent {
  readonly columns = input.required<KanbanColumn[]>();
  readonly readonly = input(false, { transform: booleanAttribute });

  readonly itemMoved = output<KanbanMoveEvent>();
  readonly itemClicked = output<KanbanItem>();
  readonly addItemClicked = output<string>();
  readonly inlineCardCreated = output<KanbanInlineCardEvent>();
  readonly menuOpened = output<KanbanColMenuEvent>();
  readonly collapseToggled = output<string>();
  readonly columnMoved = output<KanbanColumnMoveEvent>();

  /** All card drop-list IDs — passed to each column so their lists are connected. */
  protected readonly columnCardListIds = computed(() =>
    this.columns().map((c) => 'dv-col-' + c.id),
  );

  protected onColumnDrop(event: CdkDragDrop<KanbanColumn[]>): void {
    if (this.readonly()) return;
    const cols = [...this.columns()];
    moveItemInArray(cols, event.previousIndex, event.currentIndex);
    this.columnMoved.emit({
      previousIndex: event.previousIndex,
      currentIndex: event.currentIndex,
      columnIds: cols.map((c) => c.id),
    });
  }
}
