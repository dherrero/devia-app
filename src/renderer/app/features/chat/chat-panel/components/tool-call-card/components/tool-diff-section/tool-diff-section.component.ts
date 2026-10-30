import {
  ChangeDetectionStrategy, Component, inject, input,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ButtonComponent, IconComponent } from '@devia/ui';
import { LucideFileDiff } from '@lucide/angular';
import { AppStateService } from '../../../../../../../core/services/app-state.service';
import type { ToolCallRecord } from '../../../../../../../../../shared/domain/chat';
import { DiffViewerComponent } from '../../../diff-viewer/diff-viewer.component';

/** ④ DIFF → "REVISAR EN CAMBIOS": collapsible inline diff section (TS-CLI-10). */
@Component({
  selector: 'ds-tool-diff-section',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, DiffViewerComponent, TranslateModule],
  templateUrl: './tool-diff-section.component.html',
  styleUrl: './tool-diff-section.component.scss',
})
export class ToolDiffSectionComponent {
  private readonly state = inject(AppStateService);
  readonly toolCall = input.required<ToolCallRecord>();
  readonly filePath = input<string | null>(null);

  readonly LucideFileDiff = LucideFileDiff;

  focusDiff(path: string, event: Event): void {
    event.stopPropagation();
    this.state.focusedDiffFile.set(path);
  }
}
