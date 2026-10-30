import {
  ChangeDetectionStrategy, Component, computed, input,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import type { ToolCallRecord } from '../../../../../../../../../shared/domain/chat';
import { parseTodos, type TodoItem } from '../../utils/tool-call-view.utils';

/** ③ TARJETA-PLAN/TODO: TodoWrite checklist + progress render. */
@Component({
  selector: 'ds-tool-todo-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslateModule],
  templateUrl: './tool-todo-block.component.html',
  styleUrl: './tool-todo-block.component.scss',
})
export class ToolTodoBlockComponent {
  readonly toolCall = input.required<ToolCallRecord>();

  readonly todoItems = computed<TodoItem[] | null>(() =>
    parseTodos(this.toolCall().input),
  );

  readonly todoDone = computed(() => {
    const items = this.todoItems();
    if (!items) return 0;
    return items.filter((i) => i.status === 'completed').length;
  });
}
