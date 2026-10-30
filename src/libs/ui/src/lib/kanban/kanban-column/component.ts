import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  input,
  output,
  signal,
  booleanAttribute,
} from '@angular/core';
import {
  CdkDropList,
  CdkDrag,
  CdkDragDrop,
  CdkDragHandle,
  CdkDragPlaceholder,
} from '@angular/cdk/drag-drop';
import {
  KanbanColumn,
  KanbanItem,
  KanbanMoveEvent,
  KanbanInlineCardEvent,
  KanbanColMenuEvent,
} from '../kanban.models';
import { KanbanCardComponent } from '../../composite/kanban-card';

@Component({
  selector: 'dv-kanban-column',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    CdkDragPlaceholder,
    KanbanCardComponent,
  ],
  host: {
    class: 'dv-kanban-column',
    '[class.dv-kanban-column--collapsed]': 'column().collapsed',
    '[class.dv-kanban-column--done]': 'column().isDone',
    '(click)': '_onHostClick($event)',
  },
})
export class KanbanColumnComponent {
  readonly column = input.required<KanbanColumn>();
  readonly readonly = input(false, { transform: booleanAttribute });
  readonly connectedTo = input<string[]>([]);

  readonly itemMoved = output<KanbanMoveEvent>();
  readonly itemClicked = output<KanbanItem>();
  readonly addItemClicked = output<string>();
  readonly inlineCardCreated = output<KanbanInlineCardEvent>();
  readonly menuOpened = output<KanbanColMenuEvent>();
  readonly collapseToggled = output<string>();

  protected readonly inlineOpen = signal(false);
  @ViewChild('inlineArea') private inlineArea?: ElementRef<HTMLTextAreaElement>;

  protected readonly wipClass = computed(() => {
    const { wip, items } = this.column();
    if (!wip) return 'dv-kanban-column__count';
    const n = items.length;
    if (n < wip)
      return 'dv-kanban-column__count dv-kanban-column__count--wip-ok';
    if (n === wip)
      return 'dv-kanban-column__count dv-kanban-column__count--wip-warn';
    return 'dv-kanban-column__count dv-kanban-column__count--wip-over';
  });

  protected readonly wipLabel = computed(() => {
    const { wip, items } = this.column();
    return wip ? `${items.length}/${wip}` : String(items.length);
  });

  protected onDrop(event: CdkDragDrop<KanbanItem[]>): void {
    if (this.readonly()) return;
    const item: KanbanItem = event.previousContainer.data[event.previousIndex];
    this.itemMoved.emit({
      item,
      previousColumnId: event.previousContainer.id.replace('dv-col-', ''),
      currentColumnId: event.container.id.replace('dv-col-', ''),
      previousIndex: event.previousIndex,
      currentIndex: event.currentIndex,
    });
  }

  protected onMenuClick(event: MouseEvent): void {
    event.stopPropagation();
    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    this.menuOpened.emit({
      colId: this.column().id,
      anchorRect: { bottom: rect.bottom, right: rect.right },
    });
  }

  protected openInlineAdd(event?: MouseEvent): void {
    event?.stopPropagation();
    this.inlineOpen.set(true);
    setTimeout(() => this.inlineArea?.nativeElement.focus(), 0);
  }

  protected cancelInlineAdd(event?: MouseEvent): void {
    event?.stopPropagation();
    this.inlineOpen.set(false);
    if (this.inlineArea) this.inlineArea.nativeElement.value = '';
  }

  protected submitInlineAdd(event?: MouseEvent): void {
    event?.stopPropagation();
    const title = this.inlineArea?.nativeElement.value?.trim();
    if (!title) return;
    this.inlineCardCreated.emit({ columnId: this.column().id, title });
    this.cancelInlineAdd();
  }

  protected onInlineKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.submitInlineAdd();
    } else if (event.key === 'Escape') {
      this.cancelInlineAdd();
    }
  }

  _onHostClick(event: MouseEvent): void {
    if (this.column().collapsed) {
      event.stopPropagation();
      this.collapseToggled.emit(this.column().id);
    }
  }
}
