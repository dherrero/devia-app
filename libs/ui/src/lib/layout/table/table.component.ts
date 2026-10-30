import {
  ChangeDetectionStrategy,
  Component,
  ContentChildren,
  QueryList,
  booleanAttribute,
  computed,
  input,
  output,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TableColumnDef } from './table.models';
import { SkeletonComponent } from '../../atoms/skeleton/component';
import { EmptyStateComponent } from '../../composite/empty-state/component';
import { DvTableCellDirective } from './table-cell-def.directive';

@Component({
  selector: 'dv-table',
  imports: [SkeletonComponent, EmptyStateComponent, NgTemplateOutlet],
  templateUrl: './table.component.html',
  styleUrl: './table.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'dv-table-host',
    '[attr.aria-busy]': 'loading()',
  },
})
export class TableComponent {
  readonly data = input<unknown[]>([]);
  readonly columns = input<TableColumnDef[]>([]);
  readonly loading = input(false, { transform: booleanAttribute });
  readonly emptyText = input<string>('No hay datos');
  readonly density = input<'compact' | 'comfortable'>('comfortable');
  readonly stickyHeader = input(false, { transform: booleanAttribute });

  readonly rowClick = output<unknown>();
  readonly clickable = input(false, { transform: booleanAttribute });

  @ContentChildren(DvTableCellDirective)
  cellDefs!: QueryList<DvTableCellDirective>;

  protected readonly hasRowClickListeners = computed(() => this.clickable());

  protected readonly skeletonRows = [0, 1, 2] as const;

  protected readonly hostTableClass = computed(
    () => `dv-table dv-table--${this.density()}`,
  );

  protected getCellTemplate(key: string) {
    return this.cellDefs?.find((d) => d.column() === key)?.template ?? null;
  }

  protected onRowClick(row: unknown): void {
    if (this.hasRowClickListeners()) {
      this.rowClick.emit(row);
    }
  }

  protected onRowKey(event: KeyboardEvent, row: unknown): void {
    if (
      this.hasRowClickListeners() &&
      (event.key === 'Enter' || event.key === ' ')
    ) {
      event.preventDefault();
      this.rowClick.emit(row);
    }
  }

  protected cellValue(row: unknown, key: string): unknown {
    return (row as Record<string, unknown>)[key];
  }
}
