import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  input,
  output,
  signal,
  viewChildren,
} from '@angular/core';
import { MenuItemComponent } from './menu-item.component';
import {
  MenuActionItemDef,
  MenuItemDef,
  MenuZoomControlDef,
} from './menu.models';

@Component({
  selector: 'dv-menu-panel',
  imports: [MenuItemComponent],
  templateUrl: './menu-panel.component.html',
  styleUrl: './menu-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'menu',
    '[attr.aria-orientation]': '"vertical"',
    '(keydown)': 'onKeydown($event)',
    '[class.dv-menu-panel--open]': 'true',
  },
})
export class MenuPanelComponent implements OnInit {
  readonly items = input<MenuItemDef[]>([]);

  readonly itemActivated = output<MenuItemDef>();
  readonly closed = output<void>();

  readonly focusedIndex = signal(-1);

  readonly menuItems = viewChildren(MenuItemComponent, { read: ElementRef });

  ngOnInit(): void {
    // Focus the first non-disabled item after render
    setTimeout(() => {
      const firstEnabled = this.actionItems().findIndex((i) => !i.disabled);
      if (firstEnabled >= 0) {
        this.focusItem(firstEnabled);
      }
    }, 0);
  }

  onItemActivated(item: MenuItemDef): void {
    this.itemActivated.emit(item);
  }

  isZoomControl(item: MenuItemDef): item is MenuZoomControlDef {
    return item.kind === 'zoom-control';
  }

  asActionItem(item: MenuItemDef): MenuActionItemDef {
    return item as MenuActionItemDef;
  }

  onZoomAction(
    item: MenuZoomControlDef,
    action: MenuZoomControlDef['decreaseAction'],
  ): void {
    if (action.disabled) return;
    this.itemActivated.emit({
      id: action.id,
      label: action.label,
      closeOnActivate: false,
    });
  }

  onKeydown(event: KeyboardEvent): void {
    const enabledItems = this.actionItems()
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.disabled);

    if (!enabledItems.length) return;

    const currentFocused = this.focusedIndex();
    const currentEnabledPos = enabledItems.findIndex(
      ({ index }) => index === currentFocused,
    );

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const nextPos =
          currentEnabledPos < enabledItems.length - 1
            ? currentEnabledPos + 1
            : 0;
        this.focusItem(enabledItems[nextPos].index);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prevPos =
          currentEnabledPos > 0
            ? currentEnabledPos - 1
            : enabledItems.length - 1;
        this.focusItem(enabledItems[prevPos].index);
        break;
      }
      case 'Home': {
        event.preventDefault();
        this.focusItem(enabledItems[0].index);
        break;
      }
      case 'End': {
        event.preventDefault();
        this.focusItem(enabledItems[enabledItems.length - 1].index);
        break;
      }
      case 'Escape': {
        this.closed.emit();
        break;
      }
    }
  }

  private focusItem(index: number): void {
    this.focusedIndex.set(index);
    const items = this.menuItems();
    if (items[index]) {
      (items[index].nativeElement as HTMLElement).focus();
    }
  }

  private actionItems(): MenuActionItemDef[] {
    return this.items().filter(
      (item): item is MenuActionItemDef => !this.isZoomControl(item),
    );
  }
}
