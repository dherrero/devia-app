import { ChangeDetectionStrategy, Component, inject, input, model } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ButtonComponent, IconComponent, DialogRef } from '@devia/ui';
import { LucideIcon, LucideX } from '@lucide/angular';

export interface ModalNavSection {
  /** Stable id bound to the consumer's `active` model. */
  id: string;
  /** Visible label (already translated by the consumer). */
  label: string;
  /** Optional Lucide icon shown before the label. */
  icon?: LucideIcon;
  /** Optional trailing count/pill (e.g. number of installed items). */
  badge?: string | number;
}

/**
 * Master-detail shell for the large modals: a fixed header, a left section
 * rail, the active section's content on the right, and an optional action
 * footer. Mirrors the VS Code settings layout (structure only).
 *
 * Consumers provide the section list + a two-way `active` id, project the
 * section bodies (switched on `active`) into the default slot, and project
 * footer buttons into the `[shellActions]` slot. Open the host dialog with
 * `WIDE_DIALOG_OPTIONS` so the panel matches the Kanban board size.
 */
@Component({
  selector: 'ds-modal-shell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, TranslateModule],
  templateUrl: './modal-shell.component.html',
  styleUrl: './modal-shell.component.scss',
})
export class ModalShellComponent {
  readonly heading = input<string>('');
  readonly headingIcon = input<LucideIcon | null>(null);
  readonly headerTone = input<'surface' | 'surface2'>('surface');
  readonly footerTone = input<'surface' | 'surface2'>('surface');
  readonly sections = input<ModalNavSection[]>([]);
  readonly active = model<string>('');

  private readonly dialogRef = inject(DialogRef, { optional: true });

  readonly LucideX = LucideX;

  close(): void { this.dialogRef?.close(); }
}
