import { Directive, ElementRef, HostListener, inject } from '@angular/core';
import { MenuComponent } from './menu.component';

@Directive({
  selector: '[dvMenuTrigger]',
  host: {
    '[attr.aria-haspopup]': '"menu"',
    '[attr.aria-expanded]': 'menu.isOpen()',
  },
})
export class MenuTriggerDirective {
  readonly menu = inject(MenuComponent);
  readonly elementRef = inject(ElementRef<HTMLElement>);

  constructor() {
    this.menu.registerTrigger(this.elementRef);
  }

  @HostListener('click')
  onClick(): void {
    this.menu.toggle();
  }
}
