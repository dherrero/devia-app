import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

@Component({
  selector: 'dv-progress',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'progressbar',
    '[attr.aria-valuemin]': '0',
    '[attr.aria-valuemax]': '100',
    '[attr.aria-valuenow]': 'indeterminate() ? null : value()',
    '[class.dv-progress--indeterminate]': 'isIndeterminate()',
  },
})
export class ProgressComponent {
  readonly value = input<number | null>(null);
  readonly indeterminate = input(false);

  readonly isIndeterminate = computed(
    () => this.indeterminate() || this.value() === null,
  );

  readonly clampedValue = computed(() => {
    const v = this.value();
    if (v === null) return 0;
    return Math.min(100, Math.max(0, v));
  });
}
