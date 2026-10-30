import { ChangeDetectionStrategy, Component, ElementRef, inject, input } from '@angular/core';
import { MenuComponent } from '@devia/ui';

export type DsMenuTriggerButtonVariant = 'icon' | 'text';

@Component({
  // Attribute selector on a native <button> (the Angular Material `button[mat-button]`
  // idiom) so the trigger keeps real button semantics. The workspace
  // component-selector rule only allows element selectors, which doesn't fit this
  // host-enhancer pattern — the `ds` prefix convention is still honoured.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'button[dsMenuTriggerButton]',
  standalone: true,
  templateUrl: './menu-trigger-button.component.html',
  styleUrl: './menu-trigger-button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.type]': '"button"',
    '[attr.aria-label]': 'ariaLabel()',
    '[attr.aria-haspopup]': '"menu"',
    '[attr.aria-expanded]': 'menu.isOpen()',
    '[attr.title]': 'tooltip()',
    '[class.ds-menu-trigger-button]': 'true',
    '[class.ds-menu-trigger-button--text]': 'variant() === "text"',
    '(click)': 'onClick()',
  },
})
export class MenuTriggerButtonComponent {
  readonly ariaLabel = input.required<string>();
  readonly tooltip = input<string | null>(null);
  readonly variant = input<DsMenuTriggerButtonVariant>('icon');

  protected readonly menu = inject(MenuComponent);
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  constructor() {
    this.menu.registerTrigger(this.elementRef);
  }

  protected onClick(): void {
    this.menu.toggle();
  }
}
