import {
  ChangeDetectionStrategy, Component, computed, effect, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import { Dialog } from '@angular/cdk/dialog';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import {
  ButtonComponent, DialogRef, DialogService, IconComponent, InputComponent, SelectComponent,
  SpinnerComponent,
} from '@devia/ui';
import type { SelectOption } from '@devia/ui';
import { LucideCircleCheck, LucideRocket } from '@lucide/angular';

import { AppStateService } from '../../core/services/app-state.service';
import { ElectronApiService } from '../../core/services/electron-api.service';
import { ToastService } from '../../core/services/toast.service';
import { KanbanStateService } from './services/kanban-state.service';
import { TicketDetailComponent } from './components/ticket-detail/ticket-detail.component';
import { BootstrapModalComponent } from './components/bootstrap-modal/bootstrap-modal.component';
import { KanbanBoardHeaderComponent } from './components/kanban-board-header/kanban-board-header.component';
import { KanbanColumnComponent } from './components/kanban-column/kanban-column.component';
import { KanbanBlockedColumnComponent } from './components/kanban-blocked-column/kanban-blocked-column.component';
import { filterKanbanCards, type KanbanPriorityFilter } from './utils/kanban-filters';
import type { KanbanCardView, KanbanColumn, KanbanSpec } from '../../../types/devia';

const FLOW_COLUMNS: KanbanColumn[] = ['backlog', 'todo', 'in_progress', 'done'];
const DROP_IDS: Record<KanbanColumn, string> = {
  backlog: 'col-backlog',
  todo: 'col-todo',
  in_progress: 'col-in_progress',
  blocked: 'col-blocked',
  done: 'col-done',
};

/**
 * Kanban board (E-DSK-12 T4). A large dialog showing the active
 * project's specs/tasks across the SDD columns. The four flow columns
 * (ds-kanban-column) support drag-drop (CDK) → kanban_move_task; the
 * blocked column (ds-kanban-blocked-column) is display-only with three
 * sub-lanes (dependency / user / sub-agent) and is resolved from the
 * ticket detail. Cards open the ticket detail (thread + block controls).
 *
 * The board is the KanbanStateService signal, kept live via
 * onKanbanChanged — agent/MCP/UI mutations all reflect here. This
 * component owns the board/filter state and every IPC mutation; the
 * subcomponents (header, columns, cards) are presentation only.
 */
@Component({
  selector: 'ds-kanban-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent, IconComponent, InputComponent, SelectComponent, SpinnerComponent,
    FormsModule, TranslateModule,
    KanbanBoardHeaderComponent, KanbanColumnComponent, KanbanBlockedColumnComponent,
  ],
  templateUrl: './kanban-modal.component.html',
  styleUrl: './kanban-modal.component.scss',
})
export class KanbanModalComponent {
  private readonly state = inject(AppStateService);
  private readonly api = inject(ElectronApiService);
  private readonly kanban = inject(KanbanStateService);
  private readonly dialog = inject(Dialog);
  private readonly dialogs = inject(DialogService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  readonly dialogRef = inject<DialogRef<KanbanModalComponent>>(DialogRef, { optional: true });

  readonly LucideRocket = LucideRocket;
  readonly LucideCircleCheck = LucideCircleCheck;

  readonly flowColumns = FLOW_COLUMNS;
  readonly connectedTo = FLOW_COLUMNS.map((c) => DROP_IDS[c]);

  readonly project = computed(() => this.state.selectedProject() ?? '');
  readonly specs = computed(() => this.kanban.board()?.specs ?? []);
  readonly specTitles = computed<Record<string, string>>(() =>
    Object.fromEntries(this.specs().map((spec) => [spec.id, spec.title])),
  );
  readonly specCreateOptions = computed<SelectOption[]>(() =>
    this.specs().map((spec) => ({
      value: spec.id,
      label: `${spec.id} · ${spec.title}`,
    })),
  );
  readonly specFilterOptions = computed<SelectOption[]>(() => [
    {
      value: '',
      label: `${this.translate.instant('sdd.all_specs')} (${this.specs().length})`,
    },
    ...this.specCreateOptions(),
  ]);
  readonly priorityFilterOptions = computed<SelectOption[]>(() => [
    { value: 'all', label: 'Todas las prioridades' },
    { value: 'high', label: 'Alta' },
    { value: 'medium', label: 'Media' },
    { value: 'low', label: 'Baja' },
  ]);
  readonly isEmpty = computed(() => {
    const b = this.kanban.board();
    return !b || (b.specs.length === 0 && b.tasks.length === 0);
  });
  /** Planning in flight for this project: the SDD planner was kicked off
   *  (isPlanning) or an agent run is active while the board is still empty —
   *  show "planificación en curso" instead of inviting a SECOND planner. */
  readonly planningActive = computed(() => {
    const project = this.project();
    return !!project && (this.kanban.isPlanning(project) || this.state.isRunning(project));
  });
  readonly columnCount = computed(() => FLOW_COLUMNS.length + 1);
  readonly totalCards = computed(() => this.kanban.board()?.tasks.length ?? 0);

  /** The single selected spec when it is "finished": exactly one spec is
   *  picked in the filter, it has at least one task, and every one of its
   *  tasks sits in `done`. Drives the "spec finalizado · [cerrar]" bar that
   *  lets the user logically delete (archive) a completed spec. Null whenever
   *  no single spec is selected or any task is still open. */
  readonly finishedSpec = computed<KanbanSpec | null>(() => {
    const id = this.specFilter();
    if (!id) return null;
    const spec = this.specs().find((s) => s.id === id);
    if (!spec) return null;
    const tasks = (this.kanban.board()?.tasks ?? []).filter((t) => t.specId === id);
    if (tasks.length === 0) return null;
    return tasks.every((t) => t.column === 'done') ? spec : null;
  });

  // Local per-column arrays, synced from the board signal. CDK mutates
  // these on drop (optimistic); the kanban:changed event re-syncs.
  private readonly grouped = signal<Record<KanbanColumn, KanbanCardView[]>>(empty());

  readonly creating = signal(false);
  /** '' = show every spec; otherwise filter the board to a single spec. */
  readonly specFilter = signal('');
  readonly search = signal('');
  readonly priorityFilter = signal<KanbanPriorityFilter>('all');
  readonly quickAddColumn = signal<KanbanColumn | null>(null);
  newTitle = '';
  newSpecId = '';

  constructor() {
    // Always re-read the board on open. The shared signal is kept live by
    // kanban:changed events, but if one was missed (fs-watcher hiccup, event
    // raced the modal) the board would stay stale forever — a fresh IPC read
    // on open guarantees the user never stares at yesterday's board.
    const project = this.project();
    if (project) void this.kanban.loadBoard(project);
    effect(() => {
      const filter = this.specFilter();
      const specs = this.specs();
      // A stale filter (its spec was removed) falls back to showing all.
      const active = filter && specs.some((s) => s.id === filter) ? filter : '';
      const visibleTasks = filterKanbanCards(
        this.kanban.board()?.tasks ?? [],
        specs,
        this.search(),
        this.priorityFilter(),
      );
      const tasks = visibleTasks
        .filter((t) => !active || t.specId === active);
      this.grouped.set(group(tasks));
    });
  }

  /** Logical-delete (archive) the finished spec. The board view drops
   *  archived specs, so the bar vanishes and the spec filter falls back to
   *  "all specs" via the constructor effect on the next board refresh. */
  async archiveSpec(specId: string): Promise<void> {
    const project = this.project();
    if (!project) return;
    const ok = await firstValueFrom(
      this.dialogs.confirm({
        title: this.translate.instant('sdd.close_spec'),
        message: this.translate.instant('sdd.close_spec_confirm'),
        confirmLabel: this.translate.instant('sdd.close_spec_yes'),
        cancelLabel: this.translate.instant('common.cancel'),
        danger: true,
      }),
    );
    if (!ok) return;
    const archived = await this.api.kanbanArchiveSpec(project, specId);
    if (!archived) return;
    this.specFilter.set('');
    this.toast.show(this.translate.instant('sdd.spec_closed', { spec: specId }), {
      kind: 'success',
    });
  }

  cardsIn(col: KanbanColumn): KanbanCardView[] {
    return this.grouped()[col];
  }

  dropId(col: KanbanColumn): string {
    return DROP_IDS[col];
  }

  onDrop(e: CdkDragDrop<KanbanCardView[]>, target: KanbanColumn): void {
    if (e.previousContainer === e.container) {
      moveItemInArray(e.container.data, e.previousIndex, e.currentIndex);
      return;
    }
    const card = e.previousContainer.data[e.previousIndex];
    transferArrayItem(e.previousContainer.data, e.container.data, e.previousIndex, e.currentIndex);
    if (card) {
      if (target === 'done') void this.api.kanbanCloseTask(this.project(), card.id);
      else void this.api.kanbanMoveTask(this.project(), card.id, target);
    }
  }

  /** Opt-in bootstrap for an existing / already-used project (1+3):
   *  forces a fresh classification and opens the bootstrap modal so the
   *  user can prepare the project or seed a spec on demand. */
  async prepareProject(): Promise<void> {
    const project = this.project();
    if (!project) return;
    // A planner (or any run) is already working this project — launching a
    // second one would duplicate the planning conversation. Tell the user.
    if (this.planningActive()) {
      this.toast.show(this.translate.instant('sdd.planning_in_progress'), {
        kind: 'info',
        durationMs: 6000,
      });
      return;
    }
    const view = await this.api.sddBootstrap(project, true);
    // Don't stack modals: close the board before opening the intent dialog.
    this.dialogRef?.close();
    this.dialog.open(BootstrapModalComponent, {
      maxWidth: 'calc(100vw - 1.5rem)',
      maxHeight: '80vh',
      panelClass: 'dv-dialog-panel',
      backdropClass: 'dv-dialog-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      disableClose: true,
      data: { project, view },
    });
  }

  closeBoard(): void {
    if (this.dialogRef) {
      this.dialogRef.close();
      return;
    }
    void this.router.navigateByUrl('/');
  }

  open(card: KanbanCardView): void {
    // Centered modal sizing (was a full-height side drawer).
    // Before: height: '100%', maxHeight: '100%' forced the pane to fill the
    // viewport height flush right; now the panel sizes to content, capped 90vh.
    this.dialog.open(TicketDetailComponent, {
      width: 'min(42rem, 90vw)',
      maxWidth: '90vw',
      maxHeight: '90vh',
      panelClass: ['dv-modal-panel', 'dv-ticket-drawer'],
      backdropClass: 'dv-dialog-backdrop',
      data: { project: this.project(), taskId: card.id },
    });
  }

  toggleCreate(): void {
    this.creating.update((v) => !v);
    if (this.creating() && !this.newSpecId) {
      this.newSpecId = this.specFilter() || this.specs()[0]?.id || '';
    }
  }

  startQuickAdd(col: KanbanColumn): void {
    this.quickAddColumn.set(col);
  }

  cancelQuick(): void {
    this.quickAddColumn.set(null);
  }

  create(): void {
    const title = this.newTitle.trim();
    const specId = this.newSpecId || this.specs()[0]?.id;
    if (!title || !specId) return;
    void this.api.kanbanCreateTask(this.project(), specId, title);
    this.newTitle = '';
    this.creating.set(false);
  }

  async createQuick(col: KanbanColumn, rawTitle: string): Promise<void> {
    const title = rawTitle.trim();
    const specId = this.specFilter() || this.specs()[0]?.id;
    if (!title || !specId) return;
    const taskId = await this.api.kanbanCreateTask(this.project(), specId, title);
    if (!taskId) return;
    if (col === 'done') {
      await this.api.kanbanCloseTask(this.project(), taskId);
    } else if (col !== 'backlog') {
      await this.api.kanbanMoveTask(this.project(), taskId, col);
    }
    this.cancelQuick();
  }
}

function empty(): Record<KanbanColumn, KanbanCardView[]> {
  return { backlog: [], todo: [], in_progress: [], blocked: [], done: [] };
}

function group(tasks: ReadonlyArray<KanbanCardView>): Record<KanbanColumn, KanbanCardView[]> {
  const out = empty();
  for (const t of [...tasks].sort((a, b) => a.sortIndex - b.sortIndex)) {
    out[t.column].push(t);
  }
  return out;
}
