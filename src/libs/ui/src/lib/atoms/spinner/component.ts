import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

export type SpinnerSize = 'sm' | 'md' | 'lg';

@Component({
  selector: 'dv-spinner',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
    '[class]': 'hostClass()',
  },
})
export class SpinnerComponent {
  readonly size = input<SpinnerSize>('md');

  readonly hostClass = computed(() => `dv-spinner dv-spinner--${this.size()}`);

  readonly svgSize = computed(() => {
    const s = this.size();
    if (s === 'sm') return 14;
    if (s === 'lg') return 20;
    return 16;
  });

  readonly radius = computed(() => {
    const s = this.svgSize();
    return (s - 4) / 2;
  });

  readonly circumference = computed(() => 2 * Math.PI * this.radius());

  readonly dashOffset = computed(() => this.circumference() * 0.75);
}
