import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { formatTokens } from './utils/format-tokens';

/**
 * Three-state colour tone the bar paints itself with, derived from the
 * `used / limit` ratio:
 *
 * - `normal`  — under 80 %, painted with `--dv-acc`.
 * - `warning` — 80 % to <95 %, painted with `--dv-warn`.
 * - `danger`  — 95 % and above, painted with `--dv-danger`.
 *
 * Thresholds match HT-C-03 acceptance criteria
 * (`docs/od-design/HISTORIAS.md`).
 */
export type TokenMeterTone = 'normal' | 'warning' | 'danger';

/**
 * Pure-presentation widget surfaced in the statusbar (HT-C-03 / HT-ST-01).
 *
 * Renders `[model?] [used / limit] [bar]`. Inputs are required so a
 * forgotten binding fails loudly at compile time instead of silently
 * showing `NaN / 0`. The optional model label (`claude-sonnet-4.6`) is
 * left untranslated — it's a vendor model id, not a string the user reads
 * in their own language.
 */
@Component({
  selector: 'ds-token-meter',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslateModule],
  templateUrl: './token-meter.component.html',
  styleUrl: './token-meter.component.scss',
  host: { class: 'ds-token-meter' },
})
export class TokenMeterComponent {
  readonly used = input.required<number>();
  readonly limit = input.required<number>();
  readonly modelLabel = input<string | null>(null);

  readonly ratio = computed(() => {
    const limit = this.limit();
    if (!Number.isFinite(limit) || limit <= 0) return 0;
    const r = this.used() / limit;
    if (!Number.isFinite(r)) return 0;
    return Math.min(1, Math.max(0, r));
  });

  readonly tone = computed<TokenMeterTone>(() => {
    const r = this.ratio();
    if (r >= 0.95) return 'danger';
    if (r >= 0.8) return 'warning';
    return 'normal';
  });

  readonly usedLabel = computed(() => formatTokens(this.used()));
  readonly limitLabel = computed(() => formatTokens(this.limit()));
  readonly fillPercent = computed(() => this.ratio() * 100);
}
