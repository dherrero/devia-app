import {
  ChangeDetectionStrategy, Component, computed, effect, inject, signal,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import {
  ButtonComponent, DIALOG_DATA, DialogRef, DialogService, IconComponent,
} from '@devia/ui';
import {
  LucideX, LucideUnlock, LucideTrash2, LucideHelpCircle,
} from '@lucide/angular';
import { firstValueFrom } from 'rxjs';

import { ElectronApiService } from '../../../../core/services/electron-api.service';
import { KanbanStateService } from '../../services/kanban-state.service';
import { TicketThreadComponent } from './components/ticket-thread/ticket-thread.component';
import { TicketCommitsComponent } from './components/ticket-commits/ticket-commits.component';
import { TicketReplyComponent } from './components/ticket-reply/ticket-reply.component';
import { TicketSidePanelComponent, type TicketForm } from './components/ticket-side-panel/ticket-side-panel.component';
import type { KanbanColumn, KanbanTaskView } from '../../../../../types/devia';

export interface TicketDetailData {
  project: string;
  taskId: string;
}

export type TicketDetailResult =
  | { action: 'close'; taskId: string }
  | { action: 'mark-done'; taskId: string }
  | { action: 'unblock'; taskId: string }
  | { action: 'reply'; taskId: string }
  | { action: 'move'; taskId: string; column: KanbanColumn };

/**
 * Ticket detail (E-DSK-12 T4/T6). Shows a task's body, dependencies,
 * block status, and the conversation thread (user / agent / system
 * events). The user can reply — replying to a user-blocked task
 * unblocks it and wakes the agent — and close or unblock the task.
 *
 * Re-fetches whenever the board signal changes so live agent activity
 * (new thread messages, status moves) appears without polling.
 */
@Component({
  selector: 'ds-ticket-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'dv-drawer',
  },
  imports: [
    ButtonComponent, IconComponent, TranslateModule,
    TicketThreadComponent, TicketCommitsComponent, TicketReplyComponent, TicketSidePanelComponent,
  ],
  templateUrl: './ticket-detail.component.html',
  styleUrl: './ticket-detail.component.scss',
})
export class TicketDetailComponent {
  readonly data = inject<TicketDetailData>(DIALOG_DATA);
  private readonly dialogRef = inject<DialogRef<TicketDetailResult, TicketDetailComponent>>(DialogRef, { optional: true });
  private readonly api = inject(ElectronApiService);
  private readonly kanban = inject(KanbanStateService);
  private readonly dialogs = inject(DialogService);

  readonly LucideX = LucideX;
  readonly LucideUnlock = LucideUnlock;
  readonly LucideTrash2 = LucideTrash2;
  readonly LucideHelpCircle = LucideHelpCircle;

  readonly task = signal<KanbanTaskView | null>(null);

  // Staged edits — the panel no longer applies column/dueDate/done changes on
  // the fly (that closed the drawer). The user tweaks `form` freely; Save
  // commits everything that differs, then closes.
  readonly form = signal<TicketForm>({ column: 'todo', dueDate: '' });
  readonly saving = signal(false);
  readonly deleting = signal(false);
  /** Seed the form from the task once; later live reloads (agent activity)
   *  refresh the thread without clobbering the user's in-progress edits. */
  private formLoaded = false;

  readonly hasChanges = computed(() => {
    const t = this.task();
    if (!t) return false;
    const f = this.form();
    return f.column !== t.column || f.dueDate !== (t.dueDate ?? '');
  });

  readonly projectSlug = computed(() => this.data.project.split(/[\\/]/).filter(Boolean).at(-1) ?? this.data.project);
  readonly commits = computed(() => {
    const t = this.task();
    if (!t) return [];
    return t.closingCommit ? [t.closingCommit, ...t.linkedCommits.filter((c) => c !== t.closingCommit)] : t.linkedCommits;
  });

  constructor() {
    // Re-fetch the full task (thread included) whenever the board moves.
    effect(() => {
      this.kanban.board();
      void this.reload();
    });
    void this.api.kanbanMarkTaskRead(this.data.project, this.data.taskId);
  }

  private async reload(): Promise<void> {
    const t = await this.api.kanbanTask(this.data.project, this.data.taskId);
    this.task.set(t);
    if (t && !this.formLoaded) {
      this.form.set({ column: t.column, dueDate: t.dueDate ?? '' });
      this.formLoaded = true;
    }
  }

  hasThread(t: KanbanTaskView): boolean {
    return t.column !== 'backlog' || t.thread.length > 0;
  }

  blockText(t: KanbanTaskView): string {
    return t.blockTarget || (t.blockReason ? `Bloqueado por ${t.blockReason}.` : 'El agente necesita información antes de continuar.');
  }

  async onReplySent(body: string): Promise<void> {
    await this.api.kanbanComment(this.data.project, this.data.taskId, body);
    this.dialogRef?.close({ action: 'reply', taskId: this.data.taskId });
  }

  /** Commit every staged edit, then close. Due date goes through updateTask;
   *  a column change to `done` runs closeTask (system event + dependent
   *  resolution), any other column uses moveTask. */
  async save(): Promise<void> {
    const t = this.task();
    if (!t || !this.hasChanges() || this.saving()) return;
    const f = this.form();
    this.saving.set(true);
    try {
      if (f.dueDate !== (t.dueDate ?? '')) {
        await this.api.kanbanUpdateTask(this.data.project, this.data.taskId, { dueDate: f.dueDate || undefined });
      }
      if (f.column !== t.column) {
        if (f.column === 'done') {
          await this.api.kanbanCloseTask(this.data.project, this.data.taskId);
        } else {
          await this.api.kanbanMoveTask(this.data.project, this.data.taskId, f.column);
        }
      }
      this.dialogRef?.close({ action: 'move', taskId: this.data.taskId, column: f.column });
    } finally {
      this.saving.set(false);
    }
  }

  /** Delete the task, gated on an explicit second confirmation. */
  async confirmDelete(): Promise<void> {
    if (this.deleting()) return;
    const t = this.task();
    const ok = await firstValueFrom(
      this.dialogs.confirm({
        title: 'Eliminar tarea',
        message: `¿Seguro que quieres eliminar "${t?.id ?? this.data.taskId}"? Esta acción no se puede deshacer.`,
        confirmLabel: 'Eliminar',
        cancelLabel: 'Cancelar',
        danger: true,
      }),
    );
    if (!ok) return;
    this.deleting.set(true);
    try {
      await this.api.kanbanDeleteTask(this.data.project, this.data.taskId);
      this.dialogRef?.close({ action: 'close', taskId: this.data.taskId });
    } finally {
      this.deleting.set(false);
    }
  }

  unblock(): void {
    void this.api.kanbanUnblockTask(this.data.project, this.data.taskId);
    this.dialogRef?.close({ action: 'unblock', taskId: this.data.taskId });
  }

  close(): void {
    this.dialogRef?.close({ action: 'close', taskId: this.data.taskId });
  }
}
