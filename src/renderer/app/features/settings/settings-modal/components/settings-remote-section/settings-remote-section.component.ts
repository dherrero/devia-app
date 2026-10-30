import { ChangeDetectionStrategy, Component, OnInit, computed, inject, model, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonComponent, IconComponent, InputComponent, SpinnerComponent, ToggleComponent } from '@devia/ui';
import { LucideSend, LucideWifiHigh } from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import type { RemoteControlStatus, TelegramTestResult } from '../../../../../../../shared/domain/remote-control';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import { I18nService } from '../../../../../core/i18n/i18n.service';
import type { RemoteForm } from '../../models/settings-forms.model';

@Component({
  selector: 'ds-settings-remote-section',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonComponent, IconComponent, InputComponent, SpinnerComponent, ToggleComponent, TranslateModule],
  templateUrl: './settings-remote-section.component.html',
  styleUrl: './settings-remote-section.component.scss',
})
export class SettingsRemoteSectionComponent implements OnInit {
  readonly LucideSend = LucideSend;
  readonly LucideWifiHigh = LucideWifiHigh;

  /** Persisted remote-control form — owned by the parent (snapshot/save). */
  readonly remoteForm = model.required<RemoteForm>();
  /** Two-way so the parent can reflect the controller restart done on save. */
  readonly remoteStatus = model<RemoteControlStatus>({ state: 'disabled' });

  private readonly api = inject(ElectronApiService);
  private readonly translate = inject(TranslateService);
  readonly i18n = inject(I18nService);

  readonly remoteTesting = signal(false);
  readonly remoteTestResult = signal<TelegramTestResult | null>(null);
  /** Localised label for the current connection state. */
  readonly remoteStatusLabel = computed(() => {
    this.i18n.currentLanguage();
    return this.translate.instant(`modals.settings.remote_status_${this.remoteStatus().state}`);
  });

  ngOnInit(): void {
    void this.api.remoteControlGetStatus()
      .then((s) => this.remoteStatus.set(s))
      .catch(() => { /* status is best-effort */ });
  }

  updateRemoteForm<K extends keyof RemoteForm>(key: K, value: RemoteForm[K]): void {
    this.remoteForm.update((form) => ({ ...form, [key]: value }));
  }

  async testRemote(): Promise<void> {
    this.remoteTesting.set(true);
    this.remoteTestResult.set(null);
    try {
      this.remoteTestResult.set(await this.api.remoteControlTest(this.remoteForm().botToken.trim()));
    } catch {
      this.remoteTestResult.set({ ok: false, error: 'network-error' });
    } finally {
      this.remoteTesting.set(false);
    }
  }
}
