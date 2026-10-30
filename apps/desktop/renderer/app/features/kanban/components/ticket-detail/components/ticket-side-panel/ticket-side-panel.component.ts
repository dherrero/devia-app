import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import {
  CheckboxComponent, DatepickerComponent, InputComponent, SelectComponent,
  SelectOptionComponent, type SelectOption,
} from '@devia/ui';

import type { KanbanColumn, KanbanTaskView } from '../../../../../../../types/devia';

export interface TicketForm {
  column: KanbanColumn;
  dueDate: string;
}

/**
 * Side panel of the ticket detail: column / done / due-date editors
 * staged into the shared `form` model (the parent commits on Save),
 * plus read-only priority, spec id, dependencies and tags.
 */
@Component({
  selector: 'ds-ticket-side-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CheckboxComponent, DatepickerComponent, InputComponent, SelectComponent,
    SelectOptionComponent, FormsModule, TranslateModule,
  ],
  templateUrl: './ticket-side-panel.component.html',
  styleUrl: './ticket-side-panel.component.scss',
  host: {
    class: 'drawer-side',
  },
})
export class TicketSidePanelComponent {
  readonly columnOptions: readonly KanbanColumn[] = ['backlog', 'todo', 'in_progress', 'blocked', 'done'];
  readonly priorityValue = '';
  readonly priorityOptions: SelectOption[] = [
    { value: '', label: 'Sin prioridad' },
  ];

  readonly task = input.required<KanbanTaskView>();
  readonly form = model.required<TicketForm>();

  isDueDateOverdue(dateStr: string | undefined): boolean {
    if (!dateStr) return false;
    const due = new Date(`${dateStr}T23:59:59`);
    return due.getTime() < Date.now();
  }

  setColumn(value: string): void {
    if (!this.isKanbanColumn(value)) return;
    this.form.update((f) => ({ ...f, column: value }));
  }

  toggleDone(checked: boolean): void {
    if (checked) {
      this.form.update((f) => ({ ...f, column: 'done' }));
      return;
    }
    // Unchecking returns the task to where it was before (or in_progress if it
    // was already done when the panel opened).
    const original = this.task().column;
    const back: KanbanColumn = original !== 'done' ? original : 'in_progress';
    this.form.update((f) => ({ ...f, column: back }));
  }

  setDueDate(value: string): void {
    this.form.update((f) => ({ ...f, dueDate: value }));
  }

  private isKanbanColumn(value: string): value is KanbanColumn {
    return this.columnOptions.includes(value as KanbanColumn);
  }
}
