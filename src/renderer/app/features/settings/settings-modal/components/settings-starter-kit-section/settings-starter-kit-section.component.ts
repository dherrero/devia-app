import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { AlertComponent, ButtonToggleGroupComponent } from '@devia/ui';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import type { StarterKitView } from '../../../../../../../shared/domain/starter-kit';
import { AppStateService } from '../../../../../core/services/app-state.service';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import { I18nService } from '../../../../../core/i18n/i18n.service';

type ProjectChoice = 'follow' | 'on' | 'off';

/**
 * Settings › Starter kit (S-38). Unlike the memory tab it does not ride the
 * modal's Save button: each switch is applied on the spot through its own IPC,
 * because the next agent run reads it straight from the main process.
 */
@Component({
  selector: 'ds-settings-starter-kit-section',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, ButtonToggleGroupComponent, TranslateModule],
  templateUrl: './settings-starter-kit-section.component.html',
  styleUrl: './settings-starter-kit-section.component.scss',
})
export class SettingsStarterKitSectionComponent implements OnInit {
  readonly selectedAgentId = input('');

  private readonly api = inject(ElectronApiService);
  private readonly state = inject(AppStateService);
  private readonly translate = inject(TranslateService);
  private readonly i18n = inject(I18nService);

  readonly view = signal<StarterKitView | null>(null);
  readonly project = computed(() => this.state.selectedProject() ?? '');

  readonly globalItems = computed(() => {
    this.i18n.currentLanguage();
    return [
      { id: 'on', label: this.translate.instant('modals.settings.starter_kit_on') },
      { id: 'off', label: this.translate.instant('modals.settings.starter_kit_off') },
    ];
  });
  readonly projectItems = computed(() => {
    this.i18n.currentLanguage();
    return [
      { id: 'follow', label: this.translate.instant('modals.settings.starter_kit_project_follow') },
      { id: 'on', label: this.translate.instant('modals.settings.starter_kit_on') },
      { id: 'off', label: this.translate.instant('modals.settings.starter_kit_off') },
    ];
  });
  readonly projectChoice = computed<ProjectChoice>(() => {
    const override = this.view()?.projectOverride;
    return override === null || override === undefined ? 'follow' : override ? 'on' : 'off';
  });

  ngOnInit(): void {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.view.set(await this.api.starterKitStatus(this.project() || undefined));
  }

  async setGlobal(choice: string): Promise<void> {
    this.view.set(await this.api.setStarterKit({
      id: 'devia-method',
      enabled: choice === 'on',
      introSeen: true,
      ...(this.project() && { projectPath: this.project() }),
    }));
  }

  async setProject(choice: string): Promise<void> {
    if (!this.project()) return;
    this.view.set(await this.api.setStarterKit({
      id: 'devia-method',
      projectPath: this.project(),
      projectEnabled: choice === 'follow' ? null : choice === 'on',
    }));
  }
}
