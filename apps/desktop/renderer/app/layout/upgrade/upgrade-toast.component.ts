import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslateModule, TranslateService, type LangChangeEvent } from '@ngx-translate/core';
import { LucideLock, LucideX } from '@lucide/angular';
import { ButtonComponent, IconComponent } from '@devia/ui';
import { UpgradeToastService } from './services/upgrade-toast.service';

/**
 * Pro-gate notification surfaced when any feature is blocked by plan. Lives
 * at the app shell (mounted in app.component.ts) so it stays inside
 * `main.js` and is reachable for Free users — the toast IS the gate.
 *
 * No queueing: one toast at a time, dismissed explicitly (CTA or X). The
 * coalescing logic lives in {@link UpgradeToastService} so this component
 * stays presentational.
 */
@Component({
  selector: 'ds-upgrade-toast',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, TranslateModule],
  templateUrl: './upgrade-toast.component.html',
  styleUrl: './upgrade-toast.component.scss',
})
export class UpgradeToastComponent {
  readonly LucideLock = LucideLock;
  readonly LucideX = LucideX;

  readonly svc = inject(UpgradeToastService);
  private readonly translate = inject(TranslateService);

  /**
   * Re-resolve the body string whenever either the current feature OR the
   * active language changes. ngx-translate exposes lang changes through
   * `onLangChange` (an Observable); we adapt it to a signal so the computed
   * picks up locale switches without manual subscriptions.
   */
  private readonly langChange = toSignal<LangChangeEvent | undefined>(
    this.translate.onLangChange,
    { initialValue: undefined },
  );

  readonly body = computed(() => {
    void this.langChange();
    const feature = this.svc.current()?.feature;
    if (!feature) return '';
    // Prefer the feature-specific copy when present; otherwise fall back to
    // the generic body. ngx-translate returns the key itself when missing,
    // so a strict-equality check identifies "no translation".
    const specificKey = `upgrade.toast.body_${feature}`;
    const specific = this.translate.instant(specificKey);
    if (specific && specific !== specificKey) return specific;
    return this.translate.instant('upgrade.toast.body');
  });
}
