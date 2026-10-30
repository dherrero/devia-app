import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonComponent, IconComponent, TextareaComponent } from '@devia/ui';
import { LucideSend } from '@lucide/angular';

import type { KanbanTaskView } from '../../../../../../../types/devia';

/**
 * Reply composer of the ticket detail. Owns the local draft; the parent
 * keeps the IPC send (and the close-on-reply behaviour) via `sent`.
 */
@Component({
  selector: 'ds-ticket-reply',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, TextareaComponent, FormsModule],
  templateUrl: './ticket-reply.component.html',
  styleUrl: './ticket-reply.component.scss',
  host: {
    class: 'reply-area',
  },
})
export class TicketReplyComponent {
  readonly LucideSend = LucideSend;

  readonly task = input.required<KanbanTaskView>();
  readonly sent = output<string>();

  readonly draft = signal('');

  readonly placeholder = computed(() => this.task().blockReason === 'user'
    ? 'Responde al agente... Ctrl+Enter para enviar'
    : 'Añade contexto o comentario... Ctrl+Enter para enviar');

  send(): void {
    const body = this.draft().trim();
    if (!body) return;
    this.draft.set('');
    this.sent.emit(body);
  }
}
