import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ButtonComponent, DialogRef, IconComponent } from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';
import { LucideInfo, LucideLayers, LucideX } from '@lucide/angular';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import type { StatusInfo } from '../../../../types/devia';

@Component({
  selector: 'ds-status-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, TranslateModule],
  templateUrl: './status-modal.component.html',
  styleUrl: './status-modal.component.scss',
})
export class StatusModalComponent implements OnInit {
  readonly ref = inject(DialogRef, { optional: true });
  private readonly api = inject(ElectronApiService);
  readonly data = signal<StatusInfo | null>(null);
  readonly LucideInfo = LucideInfo;
  readonly LucideLayers = LucideLayers;
  readonly LucideX = LucideX;

  async ngOnInit() { this.data.set(await this.api.getStatus()); }
}
