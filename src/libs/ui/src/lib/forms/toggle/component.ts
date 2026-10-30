import {
  ChangeDetectionStrategy,
  Component,
  forwardRef,
  input,
  booleanAttribute,
  output,
  signal,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

@Component({
  selector: 'dv-toggle',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => ToggleComponent),
      multi: true,
    },
  ],
  host: {
    class: 'dv-toggle',
    '[class.dv-toggle--disabled]': 'disabled() || isDisabled()',
  },
})
export class ToggleComponent implements ControlValueAccessor {
  readonly label = input<string | null>(null);
  readonly ariaLabel = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly valueChange = output<boolean>();

  protected readonly checked = signal(false);
  protected readonly isDisabled = signal(false);
  protected readonly uid = `dv-toggle-${Math.random().toString(36).slice(2)}`;

  private onChange = (_: boolean) => {};
  private onTouched = () => {};

  protected toggle(): void {
    if (this.disabled() || this.isDisabled()) return;
    const next = !this.checked();
    this.checked.set(next);
    this.onChange(next);
    this.onTouched();
    this.valueChange.emit(next);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      this.toggle();
    }
  }

  writeValue(val: boolean): void {
    this.checked.set(!!val);
  }
  registerOnChange(fn: (_: boolean) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(disabled: boolean): void {
    this.isDisabled.set(disabled);
  }
}
