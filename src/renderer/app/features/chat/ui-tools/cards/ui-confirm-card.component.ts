import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { ButtonComponent } from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';

import type { ConfirmInput, ConfirmResult } from '../../../../../../shared/domain/ui-tools';

/**
 * Destructive-action gate asked for by the agent through `devia_confirm`
 * (S-25 F2.4).
 *
 * Devia has no interactive permission approver in its headless runtime (gemini
 * runs `--yolo`, opencode `--dangerously-skip-permissions`, codex
 * `exec --sandbox`), so this is the one checkpoint the user gets — and the
 * agent asks for it voluntarily.
 */
@Component({
  selector: 'ds-ui-confirm-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, TranslateModule],
  templateUrl: './ui-confirm-card.component.html',
  styleUrl: './ui-confirm-card.component.scss',
})
export class UiConfirmCardComponent {
  readonly input = input.required<unknown>();
  readonly decided = output<ConfirmResult>();

  protected readonly confirm = computed<ConfirmInput | null>(() => {
    const value = this.input() as ConfirmInput | null;
    return value && typeof value.action === 'string' ? value : null;
  });

  protected readonly danger = computed(() => this.confirm()?.danger === true);

  /**
   * An action the agent itself flagged as destructive can never be
   * pre-authorised. Offering "always" there would turn one careless click into
   * a standing permission for the most dangerous class of action.
   */
  protected readonly canAlwaysAllow = computed(() => !this.danger());

  protected answer(decision: ConfirmResult['decision']): void {
    this.decided.emit({ decision });
  }
}
