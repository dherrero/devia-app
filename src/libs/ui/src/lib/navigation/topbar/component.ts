import {
  ChangeDetectionStrategy,
  Component,
  input,
  booleanAttribute,
} from '@angular/core';
import type { BreadcrumbItem } from '../breadcrumb';

export type { BreadcrumbItem };

@Component({
  selector: 'dv-topbar',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'dv-topbar',
    '[class.dv-topbar--sticky]': 'sticky()',
  },
})
export class TopbarComponent {
  readonly sticky = input(false, { transform: booleanAttribute });
  readonly breadcrumbs = input<BreadcrumbItem[]>([]);
}
