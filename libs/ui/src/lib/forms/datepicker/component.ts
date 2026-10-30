import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  booleanAttribute,
  computed,
  forwardRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ConnectedPosition, OverlayModule } from '@angular/cdk/overlay';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

export type DatepickerSize = 'sm' | 'md' | 'lg';

interface CalendarDay {
  key: string;
  date: Date;
  iso: string;
  label: string;
  inCurrentMonth: boolean;
  isSelected: boolean;
  isToday: boolean;
  isDisabled: boolean;
}

let nextId = 0;

@Component({
  selector: 'dv-datepicker',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayModule],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => DatepickerComponent),
      multi: true,
    },
  ],
  host: {
    class: 'dv-datepicker-host',
    '[class.dv-datepicker-host--sm]': `size() === 'sm'`,
    '[class.dv-datepicker-host--lg]': `size() === 'lg'`,
    '[class.dv-datepicker-host--invalid]': 'error() !== null',
  },
})
export class DatepickerComponent implements ControlValueAccessor {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly label = input<string | null>(null);
  readonly inputId = input<string | null>(null);
  readonly ariaLabel = input<string | null>(null);
  readonly placeholder = input<string>('Selecciona una fecha');
  readonly hint = input<string | null>(null);
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly readonly = input(false, { transform: booleanAttribute });
  readonly required = input(false, { transform: booleanAttribute });
  readonly size = input<DatepickerSize>('md');
  readonly min = input<string | null>(null);
  readonly max = input<string | null>(null);
  readonly valueChange = output<string>();

  protected readonly value = signal('');
  protected readonly isDisabled = signal(false);
  protected readonly isOpen = signal(false);
  protected readonly overlayMinWidth = signal(0);
  protected readonly visibleMonth = signal(startOfMonth(new Date()));
  protected readonly activeDate = signal<Date | null>(null);
  protected readonly uid = `dv-datepicker-${++nextId}`;
  protected readonly dialogId = `${this.uid}-dialog`;
  protected readonly gridId = `${this.uid}-grid`;
  protected readonly weekdays = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

  protected readonly trigger =
    viewChild<ElementRef<HTMLInputElement>>('trigger');
  protected readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');

  protected readonly positions: ConnectedPosition[] = [
    {
      originX: 'start',
      originY: 'bottom',
      overlayX: 'start',
      overlayY: 'top',
      offsetY: 4,
    },
    {
      originX: 'end',
      originY: 'bottom',
      overlayX: 'end',
      overlayY: 'top',
      offsetY: 4,
    },
    {
      originX: 'start',
      originY: 'top',
      overlayX: 'start',
      overlayY: 'bottom',
      offsetY: -4,
    },
    {
      originX: 'end',
      originY: 'top',
      overlayX: 'end',
      overlayY: 'bottom',
      offsetY: -4,
    },
  ];

  protected readonly disabledState = computed(
    () => this.disabled() || this.isDisabled(),
  );
  protected readonly controlId = computed(() => this.inputId() ?? this.uid);
  protected readonly selectedDate = computed(() => parseIsoDate(this.value()));
  protected readonly activeIso = computed(() => {
    const date = this.activeDate();
    return date ? toIsoDate(date) : null;
  });
  protected readonly displayValue = computed(() => {
    const date = this.selectedDate();
    return date ? formatDisplayDate(date) : '';
  });
  protected readonly monthLabel = computed(() =>
    formatMonthLabel(this.visibleMonth()),
  );
  protected readonly ariaDescribedBy = computed(() =>
    this.error()
      ? `${this.uid}-error`
      : this.hint()
        ? `${this.uid}-hint`
        : null,
  );
  protected readonly days = computed<CalendarDay[]>(() => {
    const month = this.visibleMonth();
    const selected = this.selectedDate();
    const todayIso = toIsoDate(new Date());
    const min = parseIsoDate(this.min() ?? '');
    const max = parseIsoDate(this.max() ?? '');
    const start = startOfWeek(startOfMonth(month));

    return Array.from({ length: 42 }, (_, index) => {
      const date = addDays(start, index);
      const iso = toIsoDate(date);

      return {
        key: iso,
        date,
        iso,
        label: String(date.getDate()),
        inCurrentMonth: date.getMonth() === month.getMonth(),
        isSelected: selected ? isSameDay(date, selected) : false,
        isToday: iso === todayIso,
        isDisabled: isOutsideRange(date, min, max),
      };
    });
  });

  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};

  writeValue(value: string | null): void {
    const parsed = parseIsoDate(value ?? '');
    this.value.set(parsed ? toIsoDate(parsed) : '');
    if (parsed) {
      this.visibleMonth.set(startOfMonth(parsed));
      this.activeDate.set(parsed);
    }
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(disabled: boolean): void {
    this.isDisabled.set(disabled);
    if (disabled) this.close(false);
  }

  protected open(): void {
    if (this.disabledState() || this.readonly() || this.isOpen()) return;

    const selected = this.selectedDate();
    const today = new Date();
    const active = selected ?? today;
    this.visibleMonth.set(startOfMonth(active));
    this.activeDate.set(active);
    this.overlayMinWidth.set(
      this.host.nativeElement.getBoundingClientRect().width,
    );
    this.isOpen.set(true);

    queueMicrotask(() => this.dialog()?.nativeElement.focus());
  }

  protected close(restoreFocus = true): void {
    if (!this.isOpen()) return;

    this.isOpen.set(false);
    this.onTouched();

    if (restoreFocus) {
      queueMicrotask(() => this.trigger()?.nativeElement.focus());
    }
  }

  protected toggle(): void {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  protected previousMonth(): void {
    this.visibleMonth.update((month) => addMonths(month, -1));
  }

  protected nextMonth(): void {
    this.visibleMonth.update((month) => addMonths(month, 1));
  }

  protected selectDay(day: CalendarDay): void {
    if (day.isDisabled) return;

    this.value.set(day.iso);
    this.activeDate.set(day.date);
    this.onChange(day.iso);
    this.valueChange.emit(day.iso);
    this.close();
  }

  protected clear(): void {
    if (!this.value()) return;

    this.value.set('');
    this.onChange('');
    this.valueChange.emit('');
  }

  protected onTriggerKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
      case 'Enter':
      case ' ': {
        event.preventDefault();
        this.open();
        break;
      }
      case 'Escape': {
        this.close(false);
        break;
      }
    }
  }

  protected onDialogKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        this.moveActive(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveActive(-7);
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.moveActive(7);
        break;
      case 'Home':
        event.preventDefault();
        this.moveToWeekEdge('start');
        break;
      case 'End':
        event.preventDefault();
        this.moveToWeekEdge('end');
        break;
      case 'PageUp':
        event.preventDefault();
        this.shiftActiveMonth(-1);
        break;
      case 'PageDown':
        event.preventDefault();
        this.shiftActiveMonth(1);
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const day = this.days().find((item) => item.iso === this.activeIso());
        if (day) this.selectDay(day);
        break;
      }
      case 'Backspace':
      case 'Delete':
        event.preventDefault();
        this.clear();
        break;
      case 'Tab':
      case 'Escape':
        this.close(event.key !== 'Tab');
        break;
    }
  }

  protected setActive(day: CalendarDay): void {
    if (day.isDisabled) return;
    this.activeDate.set(day.date);
  }

  private moveActive(days: number): void {
    const current = this.activeDate() ?? this.selectedDate() ?? new Date();
    const next = addDays(current, days);
    this.activeDate.set(next);
    this.visibleMonth.set(startOfMonth(next));
  }

  private moveToWeekEdge(edge: 'start' | 'end'): void {
    const current = this.activeDate() ?? this.selectedDate() ?? new Date();
    const day = mondayIndex(current);
    const distance = edge === 'start' ? -day : 6 - day;
    this.moveActive(distance);
  }

  private shiftActiveMonth(direction: 1 | -1): void {
    const current = this.activeDate() ?? this.selectedDate() ?? new Date();
    const next = addMonths(current, direction);
    this.activeDate.set(next);
    this.visibleMonth.set(startOfMonth(next));
  }
}

function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);

  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : null;
}

function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDisplayDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function formatMonthLabel(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(date);
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfWeek(date: Date): Date {
  return addDays(date, -mondayIndex(date));
}

function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
}

function isSameDay(a: Date, b: Date): boolean {
  return toIsoDate(a) === toIsoDate(b);
}

function isOutsideRange(
  date: Date,
  min: Date | null,
  max: Date | null,
): boolean {
  const value = date.getTime();
  return (
    (min !== null && value < min.getTime()) ||
    (max !== null && value > max.getTime())
  );
}
