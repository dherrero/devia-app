import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { NgOptimizedImage } from '@angular/common';

export type AvatarSize = 'sm' | 'md' | 'lg';

@Component({
  selector: 'dv-avatar',
  imports: [NgOptimizedImage],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClass()',
  },
})
export class AvatarComponent {
  readonly initials = input<string>('');
  readonly src = input<string | null>(null);
  readonly size = input<AvatarSize>('md');

  readonly hostClass = computed(() => `dv-avatar dv-avatar--${this.size()}`);

  readonly imgSize = computed(() => {
    const s = this.size();
    if (s === 'sm') return 24;
    if (s === 'lg') return 48;
    return 32;
  });
}
