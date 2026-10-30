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
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { LucideSearch, LucideX } from '@lucide/angular';
import { IconComponent } from '../../atoms/icon';
import { TooltipDirective } from '../../atoms/tooltip';

@Component({
  selector: 'dv-search-input',
  imports: [IconComponent, TooltipDirective],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => SearchInputComponent),
      multi: true,
    },
  ],
})
export class SearchInputComponent implements ControlValueAccessor {
  readonly placeholder = input<string>('');
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly ariaLabel = input<string | null>(null);
  readonly clearTooltip = input<string>('Clear');
  readonly clearAriaLabel = input<string>('Clear');
  readonly size = input<'sm' | 'md'>('md');

  readonly valueChange = output<string>();
  readonly searchSubmitted = output<string>();
  readonly cleared = output<void>();

  protected readonly LucideSearch = LucideSearch;
  protected readonly LucideX = LucideX;
  protected readonly value = signal('');
  protected readonly isFocused = signal(false);
  protected readonly hasValue = computed(() => this.value().length > 0);
  private readonly inputEl = viewChild<ElementRef<HTMLInputElement>>('inputEl');

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
    const next = (event.target as HTMLInputElement).value;
    this.value.set(next);
    this.onChange(next);
    this.valueChange.emit(next);
  }

  protected handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    this.searchSubmitted.emit(this.value().trim());
  }

  protected handleFocus(): void {
    this.isFocused.set(true);
  }

  protected handleBlur(): void {
    this.isFocused.set(false);
    this.onTouched();
  }

  protected clear(): void {
    if (this.disabled() || this.isDisabled) return;
    this.value.set('');
    this.onChange('');
    this.valueChange.emit('');
    this.cleared.emit();
    this.focus();
  }

  protected controlDisabled(): boolean {
    return this.disabled() || this.isDisabled;
  }

  focus(): void {
    this.inputEl()?.nativeElement.focus();
  }
}
