import { LucideIcon } from '@lucide/angular';

export interface MenuActionItemDef {
  /** Optional stable identifier used by consumers to dispatch actions. */
  id?: string;
  kind?: 'item';
  label: string;
  /** Lucide icon component (web / design-system usage). */
  icon?: LucideIcon;
  /** Material icon ligature name (desktop-renderer usage).
   *  Rendered as a plain span — requires the Material Icons font on the page. */
  matIcon?: string;
  disabled?: boolean;
  destructive?: boolean;
  shortcut?: string;
  dividerBefore?: boolean;
  closeOnActivate?: boolean;
}

export interface MenuControlActionDef {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface MenuZoomControlDef {
  id?: string;
  kind: 'zoom-control';
  label: string;
  valueLabel: string;
  decreaseAction: MenuControlActionDef;
  resetAction: MenuControlActionDef;
  increaseAction: MenuControlActionDef;
  dividerBefore?: boolean;
}

export type MenuItemDef = MenuActionItemDef | MenuZoomControlDef;
