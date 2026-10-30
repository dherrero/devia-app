import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
  output,
} from '@angular/core';
import { LucideIcon } from '@lucide/angular';
import { IconComponent } from '../../atoms/icon';

@Component({
  selector: 'dv-option-card',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: {
    '[class]': 'hostClass()',
  },
})
export class OptionCardComponent {
  readonly label = input.required<string>();
  readonly description = input<string | null>(null);
  readonly icon = input<LucideIcon | null>(null);
  readonly selected = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly ariaLabel = input<string | null>(null);

  readonly selectedChange = output<void>();

  readonly hostClass = computed(
    () => `dv-option-card${this.selected() ? ' dv-option-card--selected' : ''}`,
  );

  choose(): void {
    if (this.disabled()) return;
    this.selectedChange.emit();
  }
}
