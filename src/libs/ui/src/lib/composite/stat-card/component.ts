import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  booleanAttribute,
} from '@angular/core';

@Component({
  selector: 'dv-stat-card',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'dv-stat-card',
    role: 'group',
    '[attr.aria-label]': 'label()',
  },
})
export class StatCardComponent {
  readonly label = input<string>('');
  readonly value = input<string | number>('');
  readonly sub = input<string | null>(null);
  readonly delta = input<number | null>(null);
  readonly loading = input(false, { transform: booleanAttribute });
  readonly deltaLabel = input<string | null>(null);

  protected readonly deltaSign = computed(() => {
    const d = this.delta();
    if (d === null) return null;
    return d >= 0 ? 'positive' : 'negative';
  });
}
