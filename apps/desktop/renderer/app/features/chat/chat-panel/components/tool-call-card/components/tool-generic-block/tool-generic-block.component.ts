import {
  ChangeDetectionStrategy, Component, computed, inject, input, signal,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ButtonComponent, DvCommandOutputViewerComponent, IconComponent } from '@devia/ui';
import { LucideExternalLink, LucideFolder } from '@lucide/angular';
import { ElectronApiService } from '../../../../../../../core/services/electron-api.service';
import type { ToolCallRecord } from '../../../../../../../../../shared/domain/chat';
import { isAskUserTool } from '../../../../../../../../../shared/domain/question-ask';
import { formatToolInput } from '../../utils/tool-call-view.utils';

/** Generic render (non-terminal, non-todo): file chips, formatted input, output viewer. */
@Component({
  selector: 'ds-tool-generic-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DvCommandOutputViewerComponent, IconComponent, TranslateModule],
  templateUrl: './tool-generic-block.component.html',
  styleUrl: './tool-generic-block.component.scss',
})
export class ToolGenericBlockComponent {
  private readonly api = inject(ElectronApiService);
  readonly toolCall = input.required<ToolCallRecord>();
  readonly filePath = input<string | null>(null);

  readonly LucideExternalLink = LucideExternalLink;
  readonly LucideFolder = LucideFolder;

  /** True when the tool input should be rendered as a question. */
  readonly isQuestionTool = computed(() =>
    isAskUserTool(this.toolCall().name),
  );

  readonly formattedInput = computed<string | null>(() =>
    formatToolInput(this.toolCall()),
  );

  // REV-TS-CLI-09-02: input truncation (1000 chars) mirroring the result guard.
  readonly truncatedInput = computed<string | null>(() => {
    const inp = this.formattedInput();
    if (!inp) return null;
    return inp.length > 1000 ? inp.slice(0, 1000) + '\n…[truncated]' : inp;
  });

  readonly showFullInputTrigger = computed(() =>
    (this.formattedInput()?.length ?? 0) > 1000,
  );

  readonly showFullInput = signal(false);

  readonly displayedInput = computed<string | null>(() =>
    this.showFullInput()
      ? this.formattedInput()
      : this.truncatedInput(),
  );

  toggleFullInput(): void {
    this.showFullInput.update((v) => !v);
  }

  readonly truncatedResult = computed<string | null>(() => {
    const r = this.toolCall().result;
    if (!r) return null;
    return r.length > 2000 ? r.slice(0, 2000) + '\n…[truncated]' : r;
  });

  readonly showFullTrigger = computed(() =>
    (this.toolCall().result?.length ?? 0) > 2000,
  );

  readonly showFull = signal(false);

  readonly displayedResult = computed<string>(() =>
    this.showFull()
      ? (this.toolCall().result ?? '')
      : (this.truncatedResult() ?? ''),
  );

  toggleFull(): void {
    this.showFull.update((v) => !v);
  }

  // ── ② CHIPS DE FICHERO ───────────────────────────────────────────────────

  openFileInIde(path: string): void {
    void this.api.openInIde(path).catch(() => {
      void this.api.openPath(path);
    });
  }

  revealFile(path: string): void {
    void this.api.revealInFolder(path);
  }
}
