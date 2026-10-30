import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  booleanAttribute,
  output,
} from '@angular/core';

@Component({
  selector: 'dv-card',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClasses()',
    '[attr.role]': `interactive() ? 'button' : null`,
    '[attr.tabindex]': `interactive() ? '0' : null`,
    '(click)': 'onClick($event)',
    '(keydown.enter)': 'onKeyInteract($any($event))',
    '(keydown.space)': 'onKeyInteract($any($event))',
  },
})
export class CardComponent {
  readonly variant = input<'default' | 'featured' | 'danger' | 'interactive'>(
    'default',
  );
  readonly padding = input<'sm' | 'md' | 'lg'>('md');
  readonly interactive = input(false, { transform: booleanAttribute });
  readonly selected = input(false, { transform: booleanAttribute });
  readonly selectedChange = output<boolean>();
  readonly cardClick = output<MouseEvent | KeyboardEvent>();

  protected readonly hostClasses = computed(
    () =>
      `dv-card dv-card--${this.variant()} dv-card--pad-${this.padding()}` +
      (this.selected() ? ' dv-card--selected' : '') +
      (this.interactive() ? ' dv-card--interactive' : ''),
  );

  protected onClick(event: MouseEvent): void {
    if (this.interactive()) {
      this.selectedChange.emit(!this.selected());
      this.cardClick.emit(event);
    }
  }

  protected onKeyInteract(event: KeyboardEvent): void {
    if (this.interactive()) {
      event.preventDefault();
      this.selectedChange.emit(!this.selected());
      this.cardClick.emit(event);
    }
  }
}
