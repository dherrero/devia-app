import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { ButtonComponent, ButtonToggleGroupComponent, DialogRef, DialogService, IconComponent, SearchInputComponent, SpinnerComponent, type ToggleItem } from '@devia/ui';
import { LucideHistory, LucidePin, LucideTrash2, LucideX } from '@lucide/angular';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { ToastService } from '../../../core/services/toast.service';
import type { SnapshotFeature, SnapshotSummary } from '../../../../types/devia';

type SnapshotFilter = 'all' | 'auto' | 'manual';

/**
 * Dialog listing recent config snapshots (#270).
 *
 * Minimal v1 surface:
 *   - List grouped by feature, newest first, capped at 50.
 *   - Per-row "Restaurar" / "Pin" / "Eliminar" actions.
 *
 * The undo path that the user hits the most lives in the per-feature
 * toast (e.g. skills modal "Deshacer" after install). This dialog is
 * the "I dismissed the toast — can I still get it back?" entry point.
 */
@Component({
  selector: 'ds-snapshot-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonComponent, ButtonToggleGroupComponent, IconComponent, SearchInputComponent, SpinnerComponent, TranslateModule],
  templateUrl: './snapshot-history.component.html',
  styleUrl: './snapshot-history.component.scss',
})
export class SnapshotHistoryComponent {
  readonly LucideHistory = LucideHistory;
  readonly LucidePin = LucidePin;
  readonly LucideTrash2 = LucideTrash2;
  readonly LucideX = LucideX;

  private readonly api = inject(ElectronApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly dialogs = inject(DialogService);
  readonly ref = inject(DialogRef, { optional: true });

  readonly loading = signal<boolean>(true);
  readonly rows = signal<SnapshotSummary[]>([]);
  readonly query = signal('');
  readonly filter = signal<SnapshotFilter>('all');
  readonly filterItems: ToggleItem[] = [
    { id: 'all', label: 'Todos' },
    { id: 'auto', label: 'Auto' },
    { id: 'manual', label: 'Manual' },
  ];
  readonly filteredRows = computed(() => {
    const query = this.query().trim().toLowerCase();
    const filter = this.filter();
    return this.rows().filter((row) => {
      if (filter !== 'all' && this.snapshotKind(row) !== filter) return false;
      if (!query) return true;
      const haystack = `${row.reason} ${row.feature} ${row.projectPath ?? ''}`.toLowerCase();
      return haystack.includes(query);
    });
  });

  setFilter(value: string): void {
    if (value !== 'all' && value !== 'auto' && value !== 'manual') return;
    this.filter.set(value);
  }

  constructor() {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const list = await this.api.snapshotList({});
      this.rows.set(list);
    } finally {
      this.loading.set(false);
    }
  }

  async restore(row: SnapshotSummary): Promise<void> {
    const result = await this.api.snapshotRestore(row.feature as SnapshotFeature, row.id);
    if (result.failed.length > 0) {
      this.toast.show(this.translate.instant('snapshot.history.restore_partial'), { kind: 'warning' });
    } else if (result.drift.length > 0) {
      this.toast.show(this.translate.instant('snapshot.history.restore_drift'), { kind: 'warning' });
    } else {
      this.toast.show(this.translate.instant('snapshot.history.restore_ok'), { kind: 'success' });
    }
  }

  async togglePin(row: SnapshotSummary): Promise<void> {
    await this.api.snapshotPin(row.feature as SnapshotFeature, row.id, !row.pinned);
    await this.refresh();
  }

  async remove(row: SnapshotSummary): Promise<void> {
    const ok = await firstValueFrom(
      this.dialogs.confirm({
        title: this.translate.instant('snapshot.history.delete_confirm_title'),
        message: this.translate.instant('snapshot.history.delete_confirm_message'),
        confirmLabel: this.translate.instant('snapshot.history.delete'),
        cancelLabel: this.translate.instant('common.cancel'),
        danger: true,
      }),
    );
    if (!ok) return;
    await this.api.snapshotDelete(row.feature as SnapshotFeature, row.id);
    await this.refresh();
  }

  createSnapshot(): void {
    this.ref?.close('create');
  }

  snapshotKind(row: SnapshotSummary): Exclude<SnapshotFilter, 'all'> {
    return row.feature === 'manual' ? 'manual' : 'auto';
  }

  formatDate(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
