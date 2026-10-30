import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

export type DividerOrientation = 'horizontal' | 'vertical';

@Component({
  selector: 'dv-divider',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'separator',
    '[attr.aria-orientation]': 'orientation()',
    '[class]': 'hostClass()',
  },
})
export class DividerComponent {
  readonly orientation = input<DividerOrientation>('horizontal');
  readonly label = input<string | null>(null);

  readonly hostClass = computed(
    () => `dv-divider dv-divider--${this.orientation()}`,
  );
}
