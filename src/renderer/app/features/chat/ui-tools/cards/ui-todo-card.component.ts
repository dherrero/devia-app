import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

import type { TodoItem, TodoListInput } from '../../../../../../shared/domain/ui-tools';

/**
 * Live step list published by the agent through `devia_todo` (S-25 F2.1).
 *
 * Read-only by design: the tool is fire-and-forget, so there is nothing to
 * resolve. A new call replaces this card rather than stacking a second one.
 */
@Component({
  selector: 'ds-ui-todo-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslateModule],
  templateUrl: './ui-todo-card.component.html',
  styleUrl: './ui-todo-card.component.scss',
})
export class UiTodoCardComponent {
  readonly input = input.required<unknown>();

  protected readonly items = computed<TodoItem[]>(() => {
    const value = this.input() as TodoListInput | null;
    return Array.isArray(value?.items) ? value.items : [];
  });

  protected readonly doneCount = computed(
    () => this.items().filter((i) => i.status === 'done').length,
  );

  protected readonly total = computed(() => this.items().length);

  protected readonly percent = computed(() => {
    const total = this.total();
    return total === 0 ? 0 : Math.round((this.doneCount() / total) * 100);
  });
}
