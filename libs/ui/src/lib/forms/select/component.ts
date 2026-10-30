import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  TemplateRef,
  booleanAttribute,
  computed,
  contentChildren,
  forwardRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ConnectedPosition, OverlayModule } from '@angular/cdk/overlay';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

@Component({
  selector: 'dv-select-option',
  template: `
    <ng-template #content>
      <ng-content />
    </ng-template>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'dv-select-option',
    'aria-hidden': 'true',
  },
})
export class SelectOptionComponent {
  readonly value = input.required<string>();
  readonly label = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });

  readonly template = viewChild.required<TemplateRef<unknown>>('content');
}

type SelectOptionView =
  | {
      kind: 'input';
      value: string;
      label: string;
      disabled: boolean;
      template: null;
    }
  | {
      kind: 'projected';
      value: string;
      label: string;
      disabled: boolean;
      template: TemplateRef<unknown>;
    };

@Component({
  selector: 'dv-select',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, OverlayModule],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => SelectComponent),
      multi: true,
    },
  ],
  host: {
    class: 'dv-select-host',
    '[class.dv-select-host--sm]': `size() === 'sm'`,
    '[class.dv-select-host--lg]': `size() === 'lg'`,
    '[class.dv-select-host--invalid]': 'error() !== null',
  },
})
export class SelectComponent implements ControlValueAccessor {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly label = input<string | null>(null);
  readonly ariaLabel = input<string | null>(null);
  readonly placeholder = input<string>('');
  readonly options = input<SelectOption[]>([]);
  readonly hint = input<string | null>(null);
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly required = input(false, { transform: booleanAttribute });
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  readonly valueChange = output<string>();

  protected readonly value = signal<string>('');
  protected readonly isDisabled = signal(false);
  protected readonly isOpen = signal(false);
  protected readonly activeIndex = signal(-1);
  protected readonly overlayMinWidth = signal(0);
  protected readonly uid = `dv-select-${Math.random().toString(36).slice(2)}`;
  protected readonly listboxId = `${this.uid}-listbox`;

  protected readonly trigger =
    viewChild<ElementRef<HTMLButtonElement>>('trigger');
  protected readonly listbox = viewChild<ElementRef<HTMLElement>>('listbox');
  protected readonly projectedOptions = contentChildren(SelectOptionComponent);

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
  protected readonly ariaDescribedBy = computed(() =>
    this.error()
      ? `${this.uid}-error`
      : this.hint()
        ? `${this.uid}-hint`
        : null,
  );
  protected readonly allOptions = computed<SelectOptionView[]>(() => [
    ...this.options().map((option) => ({
      kind: 'input' as const,
      value: option.value,
      label: option.label,
      disabled: option.disabled ?? false,
      template: null,
    })),
    ...this.projectedOptions().map((option) => ({
      kind: 'projected' as const,
      value: option.value(),
      label: option.label() ?? option.value(),
      disabled: option.disabled(),
      template: option.template(),
    })),
  ]);
  protected readonly selectedOption = computed(() =>
    this.allOptions().find((option) => option.value === this.value()),
  );
  protected readonly selectedLabel = computed(
    () => this.selectedOption()?.label ?? this.placeholder(),
  );
  protected readonly activeOptionId = computed(() =>
    this.isOpen() && this.activeIndex() >= 0
      ? this.optionId(this.activeIndex())
      : null,
  );

  private onChange = (_: string) => {};
  private onTouched = () => {};

  protected open(): void {
    if (this.disabledState() || this.isOpen()) return;

    this.overlayMinWidth.set(
      this.host.nativeElement.getBoundingClientRect().width,
    );
    this.activeIndex.set(this.selectedIndexOrFirstEnabled());
    this.isOpen.set(true);

    queueMicrotask(() => this.listbox()?.nativeElement.focus());
  }

  protected close(restoreFocus = true): void {
    if (!this.isOpen()) return;

    this.isOpen.set(false);
    this.activeIndex.set(-1);
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

  protected selectOption(option: SelectOptionView): void {
    if (option.disabled) return;

    this.value.set(option.value);
    this.onChange(option.value);
    this.valueChange.emit(option.value);
    this.close();
  }

  protected onTriggerKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
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

  protected onListboxKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        this.moveActive(1);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        this.moveActive(-1);
        break;
      }
      case 'Home': {
        event.preventDefault();
        this.activeIndex.set(this.firstEnabledIndex());
        break;
      }
      case 'End': {
        event.preventDefault();
        this.activeIndex.set(this.lastEnabledIndex());
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const option = this.allOptions()[this.activeIndex()];
        if (option) this.selectOption(option);
        break;
      }
      case 'Tab':
      case 'Escape': {
        this.close(event.key !== 'Tab');
        break;
      }
    }
  }

  protected optionId(index: number): string {
    return `${this.uid}-option-${index}`;
  }

  protected setActive(index: number): void {
    if (this.allOptions()[index]?.disabled) return;
    this.activeIndex.set(index);
  }

  writeValue(val: string): void {
    this.value.set(val ?? '');
  }
  registerOnChange(fn: (_: string) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(disabled: boolean): void {
    this.isDisabled.set(disabled);
    if (disabled) this.close(false);
  }

  private moveActive(direction: 1 | -1): void {
    const enabledIndexes = this.allOptions()
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !option.disabled)
      .map(({ index }) => index);

    if (!enabledIndexes.length) return;

    const current = this.activeIndex();
    const currentPosition = enabledIndexes.indexOf(current);
    const nextPosition =
      currentPosition === -1
        ? direction === 1
          ? 0
          : enabledIndexes.length - 1
        : (currentPosition + direction + enabledIndexes.length) %
          enabledIndexes.length;

    this.activeIndex.set(enabledIndexes[nextPosition]);
  }

  private selectedIndexOrFirstEnabled(): number {
    const selectedIndex = this.allOptions().findIndex(
      (option) => option.value === this.value() && !option.disabled,
    );

    return selectedIndex >= 0 ? selectedIndex : this.firstEnabledIndex();
  }

  private firstEnabledIndex(): number {
    return this.allOptions().findIndex((option) => !option.disabled);
  }

  private lastEnabledIndex(): number {
    const options = this.allOptions();
    for (let i = options.length - 1; i >= 0; i -= 1) {
      if (!options[i].disabled) return i;
    }

    return -1;
  }
}
