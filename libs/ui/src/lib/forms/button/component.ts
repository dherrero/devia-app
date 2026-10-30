import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { SpinnerComponent } from '../../atoms/spinner';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'accent'
  | 'accent-soft'
  | 'danger'
  | 'danger-soft';
export type ButtonSize = 'sm' | 'md' | 'lg';
export type ButtonShape = 'default' | 'pill';

@Component({
  selector: 'dv-button',
  imports: [SpinnerComponent],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClass()',
  },
})
export class ButtonComponent {
  readonly variant = input<ButtonVariant>('primary');
  readonly size = input<ButtonSize>('md');
  readonly type = input<'button' | 'submit' | 'reset'>('button');
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly loading = input(false, { transform: booleanAttribute });
  readonly fullWidth = input(false, { transform: booleanAttribute });
  readonly iconOnly = input(false, { transform: booleanAttribute });
  readonly ariaLabel = input<string | null>(null);
  readonly shape = input<ButtonShape>('default');
  readonly clicked = output<MouseEvent>();

  readonly isRippling = signal(false);

  readonly hostClass = computed(() => {
    const classes = ['dv-button-host'];
    if (this.fullWidth()) classes.push('dv-button-host--full-width');
    return classes.join(' ');
  });

  readonly isInteractive = computed(() => !this.disabled() && !this.loading());

  handleClick(event: MouseEvent): void {
    if (!this.isInteractive()) return;
    this.triggerRipple();
    this.clicked.emit(event);
  }

  private triggerRipple(): void {
    this.isRippling.set(true);
    setTimeout(() => this.isRippling.set(false), 300);
  }
}
