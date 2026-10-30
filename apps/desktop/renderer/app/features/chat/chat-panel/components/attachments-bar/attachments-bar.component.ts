import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { ButtonComponent, IconComponent } from '@devia/ui';
import {
  LucideFile,
  LucideFileArchive,
  LucideFileHeadphone,
  LucideFileText,
  LucideFileVideoCamera,
  LucideX,
  type LucideIcon,
} from '@lucide/angular';
import { TranslateModule } from '@ngx-translate/core';
import { formatBytes, type AttachmentKind } from '../../../../../../../shared/domain/attachment';
import type { PendingAttachment } from '../../models/pending-attachment.model';

const KIND_ICON: Partial<Record<AttachmentKind, LucideIcon>> = {
  pdf: LucideFileText,
  text: LucideFileText,
  archive: LucideFileArchive,
  video: LucideFileVideoCamera,
  audio: LucideFileHeadphone,
};

/**
 * Inline strip of pending composer attachments (HT-CH-04). Renders the
 * thumbnail (images) or file icon + size (anything else) / name / remove
 * chip described in `DESKTOP-PART-03` sub-3.4 and `DESKTOP-PART-05`
 * "Chips de Adjuntos".
 *
 * Dumb component: the parent owns the list (via
 * `PendingAttachmentsService`) and reacts to the `removed` output. Items
 * are passed as a plain readonly array — keeps the input contract type-
 * safe without leaking signal internals.
 */
@Component({
  selector: 'ds-attachments-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, TranslateModule],
  templateUrl: './attachments-bar.component.html',
  styleUrl: './attachments-bar.component.scss',
  host: { class: 'ds-attachments-bar' },
})
export class AttachmentsBarComponent {
  readonly items = input.required<readonly PendingAttachment[]>();
  readonly removed = output<string>();

  protected readonly LucideX = LucideX;
  protected readonly formatBytes = formatBytes;

  protected iconFor(kind: AttachmentKind): LucideIcon {
    return KIND_ICON[kind] ?? LucideFile;
  }

  protected onRemove(id: string): void {
    this.removed.emit(id);
  }
}
