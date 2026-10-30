import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

export type BadgeVariant =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'warn'
  | 'danger'
  | 'info'
  | 'mono';
export type BadgeSize = 'sm' | 'md' | 'lg';

@Component({
  selector: 'dv-badge',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClass()',
  },
})
export class BadgeComponent {
  readonly variant = input<BadgeVariant>('neutral');
  readonly size = input<BadgeSize>('md');
  readonly dot = input(false);

  readonly hostClass = computed(
    () => `dv-badge dv-badge--${this.variant()} dv-badge--${this.size()}`,
  );
}
