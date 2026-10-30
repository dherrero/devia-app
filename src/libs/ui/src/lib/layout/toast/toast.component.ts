import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { ToastOptions } from './toast.models';

@Component({
  selector: 'dv-toast-item',
  templateUrl: './toast.component.html',
  styleUrl: './toast.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClasses()',
    '[attr.aria-live]': `options().variant === 'danger' ? 'assertive' : 'polite'`,
  },
})
export class ToastItemComponent {
  readonly options = input.required<ToastOptions>();
  readonly dismissed = output<void>();

  protected readonly hostClasses = computed(
    () => `dv-toast dv-toast--${this.options().variant ?? 'neutral'}`,
  );
}
