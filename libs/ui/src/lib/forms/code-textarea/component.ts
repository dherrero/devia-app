import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  booleanAttribute,
  forwardRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

@Component({
  selector: 'dv-code-textarea',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => CodeTextareaComponent),
      multi: true,
    },
  ],
})
export class CodeTextareaComponent implements ControlValueAccessor {
  readonly placeholder = input<string>('');
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly readonly = input(false, { transform: booleanAttribute });
  readonly rows = input(6);
  readonly ariaLabel = input<string | null>(null);
  readonly valid = input(false, { transform: booleanAttribute });
  readonly invalid = input(false, { transform: booleanAttribute });
  readonly resize = input<'none' | 'vertical' | 'auto'>('vertical');
  readonly minHeight = input<string | null>(null);
  readonly fill = input(false, { transform: booleanAttribute });
  readonly valueChange = output<string>();

  protected readonly value = signal('');
  protected readonly isFocused = signal(false);
  private readonly textareaEl =
    viewChild<ElementRef<HTMLTextAreaElement>>('textareaEl');
  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};
  private isDisabled = false;

  writeValue(value: string): void {
    this.value.set(value ?? '');
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(disabled: boolean): void {
    this.isDisabled = disabled;
  }

  protected handleInput(event: Event): void {
    const next = (event.target as HTMLTextAreaElement).value;
    this.value.set(next);
    this.onChange(next);
    this.valueChange.emit(next);
  }

  protected handleFocus(): void {
    this.isFocused.set(true);
  }

  protected handleBlur(): void {
    this.isFocused.set(false);
    this.onTouched();
  }

  protected controlDisabled(): boolean {
    return this.disabled() || this.isDisabled;
  }

  focus(): void {
    this.textareaEl()?.nativeElement.focus();
  }
}
