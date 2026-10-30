import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  ButtonComponent, DIALOG_DATA, DialogRef, IconComponent, TextareaComponent,
} from '@devia/ui';
import { LucideArrowRight, LucideFolder, LucideRocket } from '@lucide/angular';

import { KanbanStateService } from '../../services/kanban-state.service';
import { ToastService } from '../../../../core/services/toast.service';
import type { BootstrapView } from '../../../../../types/devia';

export interface BootstrapModalData {
  project: string;
  view: BootstrapView;
}

export type BootstrapResult =
  | { action: 'later'; project: string }
  | { action: 'start-new'; project: string; intent: string }
  | { action: 'continue-existing'; project: string; intent: string };

/**
 * First-contact bootstrap modal (E-DSK-12 T2/T9 / SDD-F1).
 *
 * Asks the user a single question — what they have in mind for the
 * project — and starts the SDD flow with it. There is no "new vs
 * existing" chooser: the persisted `newProject` flag (in the view's
 * classification) decides whether to dispatch init (new) or prepare
 * (existing). The captured intent is dispatched through the normal
 * chat path.
 */
@Component({
  selector: 'ds-bootstrap-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent, IconComponent, TextareaComponent, FormsModule, TranslateModule,
  ],
  templateUrl: './bootstrap-modal.component.html',
  styleUrl: './bootstrap-modal.component.scss',
})
export class BootstrapModalComponent {
  readonly ref = inject(DialogRef, { optional: true });
  readonly data = inject<BootstrapModalData>(DIALOG_DATA);
  private readonly kanban = inject(KanbanStateService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly LucideRocket = LucideRocket;
  readonly LucideFolder = LucideFolder;
  readonly LucideArrowRight = LucideArrowRight;
  readonly intentInput = viewChild<TextareaComponent>('intentInput');

  intent = '';
  readonly busy = signal(false);

  readonly projectName = computed(() => this.data.project.split('/').pop() || this.data.project);
  readonly isExisting = computed(() => this.data.view.classification === 'existing');

  // A new project needs an intent (init seeds the spec from it); an
  // existing one can start without (prepare analyses the repo anyway).
  readonly canStart = computed(
    () => this.data.view.classification === 'existing' || this.intent.trim().length > 0,
  );

  constructor() {
    if (this.ref) this.ref.disableClose = true;
    afterNextRender(() => {
      setTimeout(() => this.intentInput()?.focus(), 0);
    });
  }

  closeLater(): void {
    this.ref?.close({ action: 'later', project: this.data.project } satisfies BootstrapResult);
  }

  async start(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.kanban.startSddPlanning(
        this.data.project,
        this.data.view.classification,
        this.intent.trim(),
      );
      this.toast.show(this.translate.instant('sdd.bootstrap_started'), { kind: 'success' });
      this.ref?.close({
        action: this.isExisting() ? 'continue-existing' : 'start-new',
        project: this.data.project,
        intent: this.intent.trim(),
      } satisfies BootstrapResult);
    } catch {
      this.toast.show(this.translate.instant('sdd.bootstrap_error'), { kind: 'error', durationMs: 8000 });
      this.busy.set(false);
    }
  }
}
