import {
  ChangeDetectionStrategy, Component, computed, effect, inject, input, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { TranslateModule } from '@ngx-translate/core';
import { ButtonComponent, CodeTextareaComponent, IconComponent, TooltipDirective } from '@devia/ui';
import {
  LucideList, LucidePlay, LucidePause, LucideTrash2, LucidePauseCircle,
  LucideGripVertical, LucidePencil, LucideX,
} from '@lucide/angular';
import { AppStateService } from '../../../core/services/app-state.service';
import { QueueService } from './services/queue.service';
import type { QueueItem } from '../../../../types/devia';

/**
 * Per-project instruction queue panel.
 *
 * Sits between the message scroll and the input bar. It hides itself
 * when the active queue is empty AND the panel is not paused — i.e.
 * there is nothing to show. The chrome reappears the moment the user
 * enqueues something or pauses the queue from a menu.
 */
@Component({
  selector: 'ds-queue-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TooltipDirective, 
    FormsModule, DragDropModule,
    ButtonComponent,
    CodeTextareaComponent,
    IconComponent, TooltipDirective,
    TranslateModule,
  ],
  templateUrl: './queue-panel.component.html',
  styleUrl: './queue-panel.component.scss',
})
export class QueuePanelComponent {
  readonly LucideList = LucideList;
  readonly LucidePlay = LucidePlay;
  readonly LucidePause = LucidePause;
  readonly LucideTrash2 = LucideTrash2;
  readonly LucidePauseCircle = LucidePauseCircle;
  readonly LucideGripVertical = LucideGripVertical;
  readonly LucidePencil = LucidePencil;
  readonly LucideX = LucideX;
  private readonly state = inject(AppStateService);
  private readonly queue = inject(QueueService);

  // Session input (T-149): the owning chat pane binds its project so the queue
  // is per-panel. Unbound (legacy/standalone) it falls back to the global
  // selection so the single-pane case is unchanged.
  readonly project = input<string | null>(null);
  readonly effectiveProject = computed(() => this.project() ?? this.state.selectedProject());
  private readonly selector = this.queue.selector(this.effectiveProject);
  readonly view = this.selector.view;
  readonly items = computed<QueueItem[]>(() => this.view().items);

  readonly editingId = signal<string | null>(null);
  readonly editDraft = signal('');
  readonly confirmingClear = signal(false);

  private clearTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Hydrate the per-project view the first time we see a new selection.
    // Listening passively to `queue:changed` covers every subsequent
    // mutation; this only needs to pull once per project.
    effect(() => {
      const p = this.effectiveProject();
      if (p) void this.queue.ensureHydrated(p);
      // Drop transient UI state whenever the selection switches.
      this.editingId.set(null);
      this.editDraft.set('');
      this.cancelClearConfirmation();
    });
  }

  // -- DnD reorder ---------------------------------------------------------
  onDrop(e: CdkDragDrop<QueueItem[]>) {
    if (e.previousIndex === e.currentIndex) return;
    const p = this.effectiveProject();
    if (!p) return;
    // Optimistically reorder the local view so the drop feels instant;
    // the canonical state will arrive via queue:changed shortly.
    const arr = [...this.items()];
    moveItemInArray(arr, e.previousIndex, e.currentIndex);
    const moved = arr[e.currentIndex];
    if (!moved) return;
    void this.queue.move(p, moved.id, e.currentIndex);
  }

  // -- Inline edit ---------------------------------------------------------
  startEdit(item: QueueItem) {
    this.editingId.set(item.id);
    this.editDraft.set(item.text);
  }
  cancelEdit() {
    this.editingId.set(null);
    this.editDraft.set('');
  }
  onEditEnter(e: Event, item: QueueItem) {
    const ev = e as KeyboardEvent;
    if (ev.shiftKey) return;
    ev.preventDefault();
    this.commitEdit(item);
  }
  commitEdit(item: QueueItem) {
    const p = this.effectiveProject();
    if (!p) return;
    const text = this.editDraft().trim();
    if (!text || text === item.text) {
      this.cancelEdit();
      return;
    }
    void this.queue.edit(p, item.id, text);
    this.cancelEdit();
  }

  // -- Single-item delete --------------------------------------------------
  remove(item: QueueItem) {
    const p = this.effectiveProject();
    if (!p) return;
    void this.queue.remove(p, item.id);
  }

  // -- Clear-with-confirmation. First click arms, second click commits.
  //    The arm resets after 2.5s so a stale "confirm" can't fire later.
  confirmClear() {
    const p = this.effectiveProject();
    if (!p) return;
    if (this.confirmingClear()) {
      this.cancelClearConfirmation();
      void this.queue.clear(p);
      return;
    }
    this.confirmingClear.set(true);
    this.clearTimer = setTimeout(() => this.cancelClearConfirmation(), 2500);
  }
  private cancelClearConfirmation() {
    this.confirmingClear.set(false);
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
  }

  // -- Pause / resume ------------------------------------------------------
  pause() {
    const p = this.effectiveProject();
    if (p) void this.queue.pause(p);
  }
  resume() {
    const p = this.effectiveProject();
    if (p) void this.queue.resume(p);
  }
}
