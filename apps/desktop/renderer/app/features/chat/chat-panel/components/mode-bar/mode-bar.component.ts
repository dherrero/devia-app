import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TooltipDirective } from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';
import {
  RUN_MODE_OPTIONS,
  type RunMode,
  type RunModeOption,
} from '../../models/run-mode.model';

/**
 * Plan / Apply / YOLO segmented control (HT-MD-01).
 *
 * Implements `DESKTOP-PART-06-MODE-BAR.md`: 3 segments separated by a
 * 0.25rem gap, hosted on the chat-panel between the queue and the input
 * bar. The YOLO segment carries the `danger` tone so the active state
 * paints red — a visual reminder that the agent will skip every
 * confirmation prompt.
 *
 * Stateless: the parent owns the active mode (typically
 * `AppStateService.runMode`) and reacts to `modeChange`.
 */
@Component({
  selector: 'ds-mode-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TooltipDirective, TranslateModule],
  templateUrl: './mode-bar.component.html',
  styleUrl: './mode-bar.component.scss',
  host: { class: 'ds-mode-bar' },
})
export class ModeBarComponent {
  readonly mode = input.required<RunMode>();
  readonly modeChange = output<RunMode>();

  readonly options: readonly RunModeOption[] = RUN_MODE_OPTIONS;

  protected onSelect(option: RunModeOption): void {
    if (option.id === this.mode()) return;
    this.modeChange.emit(option.id);
  }
}
