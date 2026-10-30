import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  booleanAttribute,
  output,
} from '@angular/core';
import { KanbanItem, KANBAN_LABELS } from '../../kanban/kanban.models';

const MONTHS = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

@Component({
  selector: 'dv-kanban-card',
  imports: [],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClasses()',
    '[attr.role]': `disabled() ? null : 'button'`,
    '[attr.tabindex]': `disabled() ? null : '0'`,
    '[attr.aria-selected]': 'selected() || null',
    '(click)': 'onActivate()',
    '(keydown.enter)': 'onActivate()',
    '(keydown.space)': 'onActivateSpace($event)',
  },
})
export class KanbanCardComponent {
  readonly item = input.required<KanbanItem>();
  readonly selected = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly done = input(false, { transform: booleanAttribute });
  readonly opened = output<KanbanItem>();
  readonly selectedChange = output<KanbanItem>();

  protected readonly labelMap = KANBAN_LABELS;

  protected readonly hostClasses = computed(
    () =>
      'dv-kanban-card' +
      (this.selected() ? ' dv-kanban-card--selected' : '') +
      (this.disabled() ? ' dv-kanban-card--disabled' : '') +
      (this.done() ? ' dv-kanban-card--done' : ''),
  );

  protected readonly priorityClass = computed(() => {
    const p = this.item().priority;
    if (p === 'alta') return 'dv-kanban-card__priority--alta';
    if (p === 'media') return 'dv-kanban-card__priority--media';
    return '';
  });

  protected readonly dueDateClass = computed(() => {
    const d = this.item().dueDate;
    if (!d) return '';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(d);
    due.setHours(0, 0, 0, 0);
    if (due < today) return 'dv-kanban-card__due--overdue';
    if (due.getTime() === today.getTime()) return 'dv-kanban-card__due--today';
    const diffDays = Math.ceil((due.getTime() - today.getTime()) / 86_400_000);
    if (diffDays <= 3) return 'dv-kanban-card__due--upcoming';
    return '';
  });

  protected readonly dueDateLabel = computed(() => {
    const d = this.item().dueDate;
    if (!d) return '';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(d);
    due.setHours(0, 0, 0, 0);
    if (due.getTime() === today.getTime()) return 'Hoy';
    const suffix = due < today ? ' ✕' : '';
    return `${due.getDate()} ${MONTHS[due.getMonth()]}${suffix}`;
  });

  protected onActivate(): void {
    if (this.disabled()) return;
    this.opened.emit(this.item());
  }

  protected onActivateSpace(event: Event): void {
    event.preventDefault();
    this.onActivate();
  }
}
