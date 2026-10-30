import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { DialogRef, IconComponent, SearchInputComponent } from '@devia/ui';
import { LucideCheck, LucideCloud, LucideGitBranch } from '@lucide/angular';
import { AppStateService } from '../../../core/services/app-state.service';
import type { BranchRef } from '../../../../../shared/domain/git';

/**
 * Splits + filters branches into local/remote groups. Pure (exported) so the
 * grouping/filter logic is unit-testable without a TestBed.
 */
export function groupBranches(
  all: BranchRef[],
  query: string,
): { local: BranchRef[]; remote: BranchRef[] } {
  const q = query.trim().toLowerCase();
  const match = (b: BranchRef) => q === '' || b.name.toLowerCase().includes(q);
  return {
    local: all.filter((b) => !b.isRemote && match(b)),
    remote: all.filter((b) => b.isRemote && match(b)),
  };
}

@Component({
  selector: 'ds-branch-switcher',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SearchInputComponent, IconComponent, TranslateModule],
  templateUrl: './branch-switcher.component.html',
  styleUrl: './branch-switcher.component.scss',
})
export class BranchSwitcherComponent {
  private readonly state = inject(AppStateService);
  private readonly dialogRef = inject(DialogRef, { optional: true });

  readonly LucideGitBranch = LucideGitBranch;
  readonly LucideCloud = LucideCloud;
  readonly LucideCheck = LucideCheck;

  readonly loading = signal(true);
  readonly branches = signal<BranchRef[]>([]);
  readonly query = signal('');

  readonly groups = computed(() => groupBranches(this.branches(), this.query()));
  readonly empty = computed(() => {
    const g = this.groups();
    return g.local.length === 0 && g.remote.length === 0;
  });

  constructor() {
    void this.state.listBranches().then((b) => {
      this.branches.set(b);
      this.loading.set(false);
    });
  }

  onPick(ref: BranchRef): void {
    if (ref.isCurrent) return;
    this.dialogRef?.close();
    void this.state.checkoutBranch({ name: ref.name, isRemote: ref.isRemote });
  }

  /** "hace 3 h" style label from a unix-seconds timestamp. */
  relative(unixSeconds: number): string {
    if (!unixSeconds) return '';
    const diffSec = Math.round(Date.now() / 1000 - unixSeconds);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    const units: [Intl.RelativeTimeFormatUnit, number][] = [
      ['year', 31536000],
      ['month', 2592000],
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60],
    ];
    for (const [unit, secs] of units) {
      if (Math.abs(diffSec) >= secs) {
        return rtf.format(-Math.round(diffSec / secs), unit);
      }
    }
    return rtf.format(-diffSec, 'second');
  }
}
