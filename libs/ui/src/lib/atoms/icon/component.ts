import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { LucideIcon } from '@lucide/angular';

export type IconSize = 'sm' | 'md' | 'lg';

@Component({
  selector: 'dv-icon',
  imports: [NgComponentOutlet],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.aria-hidden]': 'decorative() ? "true" : null',
    '[attr.aria-label]': '!decorative() ? label() : null',
    '[class]': 'hostClass()',
  },
})
export class IconComponent {
  readonly icon = input.required<LucideIcon>();
  readonly size = input<IconSize>('md');
  readonly decorative = input(true);
  readonly label = input<string | null>(null);

  readonly hostClass = computed(() => `dv-icon dv-icon--${this.size()}`);
}
