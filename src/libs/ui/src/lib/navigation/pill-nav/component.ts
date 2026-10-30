import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';

export interface PillNavItem {
  id: string;
  label: string;
  href?: string;
  disabled?: boolean;
}

@Component({
  selector: 'dv-pill-nav',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dv-pill-nav', role: 'navigation' },
})
export class PillNavComponent {
  readonly items = input<PillNavItem[]>([]);
  readonly activeId = input<string | null>(null);
  readonly activeChanged = output<string>();

  protected select(item: PillNavItem): void {
    if (item.disabled) return;
    this.activeChanged.emit(item.id);
  }
}
