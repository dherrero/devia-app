import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { BadgeComponent, ButtonComponent, IconComponent } from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';
import {
  LucideFile, LucideFilm, LucideFileText, LucideExternalLink, LucideFolder, LucideSend,
  type LucideIcon,
} from '@lucide/angular';
import { ElectronApiService } from '../../../../../../../core/services/electron-api.service';
import type { ChatBubbleMessage } from '../../../../models/chat-bubble-contract.model';

@Component({
  selector: 'ds-outbox-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponent, ButtonComponent, IconComponent, TranslateModule],
  templateUrl: './outbox-card.component.html',
  styleUrl: './outbox-card.component.scss',
})
export class OutboxCardComponent {
  readonly LucideFile = LucideFile;
  readonly LucideExternalLink = LucideExternalLink;
  readonly LucideFolder = LucideFolder;
  readonly LucideSend = LucideSend;
  readonly api = inject(ElectronApiService);

  readonly msg = input.required<ChatBubbleMessage>();

  readonly fileUri = computed(() => {
    const p = this.msg().path;
    return p ? 'file://' + encodeURI(p) : '';
  });

  readonly kindIconLucide = computed<LucideIcon>(() => {
    const k = this.msg().kind;
    return k === 'video' ? LucideFilm : LucideFileText;
  });
}
