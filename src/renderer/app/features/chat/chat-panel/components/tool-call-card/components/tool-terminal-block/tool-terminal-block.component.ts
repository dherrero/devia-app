import {
  ChangeDetectionStrategy, Component, computed, input, signal,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ButtonComponent, DvCommandOutputViewerComponent, IconComponent } from '@devia/ui';
import { LucideCheck, LucideCopy } from '@lucide/angular';
import type { ToolCallRecord } from '../../../../../../../../../shared/domain/chat';
import { formatTerminalCommandForDisplay } from '../../../../../../../../../shared/domain/tool-call.helpers';
import { formatToolInput } from '../../utils/tool-call-view.utils';

/** ① BURBUJA-TERMINAL: Bash / Execute special render. */
@Component({
  selector: 'ds-tool-terminal-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DvCommandOutputViewerComponent, IconComponent, TranslateModule],
  templateUrl: './tool-terminal-block.component.html',
  styleUrl: './tool-terminal-block.component.scss',
})
export class ToolTerminalBlockComponent {
  readonly toolCall = input.required<ToolCallRecord>();

  readonly LucideCheck = LucideCheck;
  readonly LucideCopy = LucideCopy;

  readonly rawTerminalCommand = computed<string>(() => {
    const tc = this.toolCall();
    const cmd = (tc.input as { command?: unknown } | null)?.command;
    return typeof cmd === 'string' ? cmd : (formatToolInput(tc) ?? '');
  });

  readonly terminalCommand = computed<string>(() =>
    formatTerminalCommandForDisplay(this.rawTerminalCommand()),
  );

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

  /** Flash signals for the two copy buttons in the terminal block. */
  readonly copiedCmd = signal(false);
  readonly copiedOut = signal(false);
  private _cmdTimer: ReturnType<typeof setTimeout> | null = null;
  private _outTimer: ReturnType<typeof setTimeout> | null = null;

  copyCommand(): void {
    const text = this.rawTerminalCommand();
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      this.copiedCmd.set(true);
      if (this._cmdTimer) clearTimeout(this._cmdTimer);
      this._cmdTimer = setTimeout(() => this.copiedCmd.set(false), 1400);
    }).catch((err: unknown) => {
      console.error('[tool-card] clipboard write failed:', err);
    });
  }

  copyOutput(): void {
    const text = this.toolCall().result ?? '';
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      this.copiedOut.set(true);
      if (this._outTimer) clearTimeout(this._outTimer);
      this._outTimer = setTimeout(() => this.copiedOut.set(false), 1400);
    }).catch((err: unknown) => {
      console.error('[tool-card] clipboard write failed:', err);
    });
  }
}
