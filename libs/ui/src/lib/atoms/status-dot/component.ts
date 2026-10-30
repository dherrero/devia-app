import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

export type StatusDotVariant =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'warn'
  | 'danger'
  | 'info';

@Component({
  selector: 'dv-status-dot',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClass()',
  },
})
export class StatusDotComponent {
  readonly variant = input<StatusDotVariant>('neutral');
  readonly label = input<string | null>(null);
  readonly showLabel = input(false);

  readonly hostClass = computed(
    () => `dv-status-dot dv-status-dot--${this.variant()}`,
  );
}
