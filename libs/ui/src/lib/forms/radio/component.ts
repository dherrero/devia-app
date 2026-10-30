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

export interface RadioOption {
  value: string;
  label: string;
  disabled?: boolean;
}

@Component({
  selector: 'dv-radio-group',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => RadioGroupComponent),
      multi: true,
    },
  ],
  host: {
    role: 'radiogroup',
    class: 'dv-radio-group',
    '[class.dv-radio-group--disabled]': 'disabled() || isDisabled()',
  },
})
export class RadioGroupComponent implements ControlValueAccessor {
  readonly options = input<RadioOption[]>([]);
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly name = input(`dv-radio-${Math.random().toString(36).slice(2)}`);
  readonly valueChange = output<string>();

  protected readonly selected = signal<string>('');
  protected readonly isDisabled = signal(false);

  private onChange = (_: string) => {};
  private onTouched = () => {};

  protected select(value: string, opt: RadioOption): void {
    if (this.disabled() || this.isDisabled() || opt.disabled) return;
    this.selected.set(value);
    this.onChange(value);
    this.onTouched();
    this.valueChange.emit(value);
  }

  writeValue(val: string): void {
    this.selected.set(val ?? '');
  }
  registerOnChange(fn: (_: string) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(disabled: boolean): void {
    this.isDisabled.set(disabled);
  }
}
