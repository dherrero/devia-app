import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  booleanAttribute,
  output,
} from '@angular/core';

@Component({
  selector: 'dv-alert',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClasses()',
    role: 'alert',
  },
})
export class AlertComponent {
  readonly variant = input<'success' | 'warn' | 'danger' | 'info' | 'neutral'>(
    'neutral',
  );
  readonly title = input<string>('');
  readonly dismissible = input(false, { transform: booleanAttribute });
  readonly dismissed = output<void>();

  protected readonly hostClasses = computed(
    () => `dv-alert dv-alert--${this.variant()}`,
  );
}
