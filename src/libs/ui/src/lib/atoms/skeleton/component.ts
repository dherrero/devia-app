import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { numberAttribute } from '@angular/core';

export type SkeletonVariant = 'text' | 'title' | 'avatar' | 'rect';

@Component({
  selector: 'dv-skeleton',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
    '[class]': 'hostClass()',
  },
})
export class SkeletonComponent {
  readonly variant = input<SkeletonVariant>('text');
  readonly lines = input(1, { transform: numberAttribute });

  readonly hostClass = computed(
    () => `dv-skeleton dv-skeleton--${this.variant()}`,
  );

  readonly linesArray = computed(() => Array.from({ length: this.lines() }));
}
