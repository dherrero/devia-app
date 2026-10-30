import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonComponent, DialogRef, IconComponent, InputComponent } from '@devia/ui';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideArrowRight, LucideCheck, LucideFolderOpen, LucideX } from '@lucide/angular';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { AppStateService } from '../../../core/services/app-state.service';

@Component({
  selector: 'ds-workspace-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, FormsModule, IconComponent, InputComponent, TranslateModule],
  templateUrl: './workspace-modal.component.html',
  styleUrl: './workspace-modal.component.scss',
})
export class WorkspaceModalComponent {
  private readonly api = inject(ElectronApiService);
  private readonly state = inject(AppStateService);
  readonly ref = inject(DialogRef, { optional: true });
  private readonly translate = inject(TranslateService);
  readonly LucideArrowRight = LucideArrowRight;
  readonly LucideCheck = LucideCheck;
  readonly LucideFolderOpen = LucideFolderOpen;
  readonly LucideX = LucideX;

  readonly picked = signal('');
  readonly saving = signal(false);
  readonly hasExistingWorkspace = computed(() => !!this.state.config()?.workspaceRoot);

  async browse() {
    const folder = await this.api.pickFolder({ title: this.translate.instant('modals.workspace.dialog_title') });
    if (folder) this.picked.set(folder);
  }

  async save() {
    const path = this.picked();
    if (!path || this.saving()) return;
    this.saving.set(true);
    try {
      await this.state.setWorkspace(path);
      this.ref?.close(true);
    } finally {
      this.saving.set(false);
    }
  }

  cancel(): void {
    this.ref?.close(false);
  }
}
