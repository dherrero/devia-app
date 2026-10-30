import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  booleanAttribute,
  computed,
  forwardRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  ControlValueAccessor,
  FormsModule,
  NG_VALUE_ACCESSOR,
} from '@angular/forms';

let nextId = 0;

@Component({
  selector: 'dv-input',
  imports: [FormsModule],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => InputComponent),
      multi: true,
    },
  ],
})
export class InputComponent implements ControlValueAccessor {
  readonly label = input<string | null>(null);
  readonly placeholder = input<string>('');
  readonly hint = input<string | null>(null);
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly readonly = input(false, { transform: booleanAttribute });
  readonly required = input(false, { transform: booleanAttribute });
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  readonly prefix = input<string | null>(null);
  readonly suffix = input<string | null>(null);
  readonly type = input<string>('text');
  readonly ariaLabel = input<string | null>(null);
  readonly autocomplete = input<string | null>(null);
  readonly inputmode = input<string | null>(null);
  readonly pattern = input<string | null>(null);
  readonly spellcheck = input<boolean | null>(null);
  readonly valueChange = output<string>();
  readonly focused = output<FocusEvent>();
  readonly blurred = output<FocusEvent>();

  readonly id = `dv-input-${++nextId}`;
  readonly hintId = `${this.id}-hint`;
  readonly errorId = `${this.id}-error`;

  readonly value = signal<string>('');
  readonly isFocused = signal(false);
  readonly isTouched = signal(false);
  private readonly inputEl = viewChild<ElementRef<HTMLInputElement>>('inputEl');

  readonly describedBy = computed(() => {
    const parts: string[] = [];
    if (this.error()) parts.push(this.errorId);
    else if (this.hint()) parts.push(this.hintId);
    return parts.join(' ') || null;
  });

  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};

  writeValue(value: string): void {
    this.value.set(value ?? '');
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    // Managed by disabled input signal
    void isDisabled;
  }

  handleInput(event: Event): void {
    const val = (event.target as HTMLInputElement).value;
    this.value.set(val);
    this.onChange(val);
    this.valueChange.emit(val);
  }

  handleFocus(event: FocusEvent): void {
    this.isFocused.set(true);
    this.focused.emit(event);
  }

  handleBlur(event: FocusEvent): void {
    this.isFocused.set(false);
    this.isTouched.set(true);
    this.onTouched();
    this.blurred.emit(event);
  }

  focus(): void {
    this.inputEl()?.nativeElement.focus();
  }

  select(): void {
    this.inputEl()?.nativeElement.select();
  }
}
