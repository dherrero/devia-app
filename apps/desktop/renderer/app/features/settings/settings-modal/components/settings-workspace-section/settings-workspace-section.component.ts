import { Dialog } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonComponent, InputComponent, SelectComponent } from '@devia/ui';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import { I18nService } from '../../../../../core/i18n/i18n.service';
import { SUPPORTED_LANGUAGES } from '../../../../../core/i18n/supported-languages';
import type { WorkspaceForm } from '../../models/settings-forms.model';

@Component({
  selector: 'ds-settings-workspace-section',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonComponent, InputComponent, SelectComponent, TranslateModule],
  templateUrl: './settings-workspace-section.component.html',
  styleUrl: './settings-workspace-section.component.scss',
})
export class SettingsWorkspaceSectionComponent {
  readonly workspaceForm = model.required<WorkspaceForm>();
  readonly configPath = input('');

  private readonly api = inject(ElectronApiService);
  private readonly translate = inject(TranslateService);
  private readonly dialog = inject(Dialog);
  readonly i18n = inject(I18nService);

  readonly languages = SUPPORTED_LANGUAGES;

  updateWorkspaceForm<K extends keyof WorkspaceForm>(key: K, value: WorkspaceForm[K]): void {
    this.workspaceForm.update((form) => ({ ...form, [key]: value }));
  }

  async pickFolder(key: keyof WorkspaceForm) {
    const folder = await this.api.pickFolder({ title: this.translate.instant('modals.settings.dialog_title') });
    if (folder) this.workspaceForm.update((f) => ({ ...f, [key]: folder }));
  }

  /** #270 — open the config-snapshot history dialog. */
  openSnapshotHistory(): void {
    void import('../../../snapshot-history/snapshot-history.component').then(({ SnapshotHistoryComponent }) => {
      this.dialog.open(SnapshotHistoryComponent, {
        maxWidth: 'calc(100vw - 2rem)',
        maxHeight: 'calc(100vh - 2rem)',
        panelClass: 'dv-dialog-panel',
        backdropClass: 'dv-dialog-backdrop',
        autoFocus: 'first-tabbable',
        restoreFocus: true,
      });
    });
  }
}
