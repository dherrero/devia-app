import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { MenuActionItemDef } from './menu.models';

@Component({
  selector: 'dv-menu-item',
  imports: [NgComponentOutlet],
  templateUrl: './menu-item.component.html',
  styleUrl: './menu-item.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.role]': '"menuitem"',
    '[attr.aria-disabled]': 'item().disabled ? "true" : null',
    '[attr.aria-current]': 'active() ? "page" : null',
    '[attr.tabindex]': 'item().disabled ? "-1" : "0"',
    '[class]': 'hostClass()',
    '(click)': 'handleClick()',
    '(keydown.enter)': 'handleClick()',
    '(keydown.space)': '$event.preventDefault(); handleClick()',
  },
})
export class MenuItemComponent {
  readonly item = input.required<MenuActionItemDef>();
  readonly active = input(false);

  readonly activated = output<MenuActionItemDef>();

  readonly hostClass = computed(() => {
    const classes = ['dv-menu-item'];
    if (this.item().disabled) classes.push('dv-menu-item--disabled');
    if (this.item().destructive) classes.push('dv-menu-item--destructive');
    if (this.active()) classes.push('dv-menu-item--active');
    return classes.join(' ');
  });

  handleClick(): void {
    if (this.item().disabled) return;
    this.activated.emit(this.item());
  }
}
