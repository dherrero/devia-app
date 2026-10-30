import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  booleanAttribute,
} from '@angular/core';
import { LucideIcon } from '@lucide/angular';
import { IconComponent } from '../../atoms/icon';

export interface NavItem {
  id: string;
  label: string;
  href?: string;
  icon?: LucideIcon;
  disabled?: boolean;
  active?: boolean;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

@Component({
  selector: 'dv-sidebar-nav',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: {
    class: 'dv-sidebar-nav',
    '[class.dv-sidebar-nav--collapsed]': 'collapsed()',
  },
})
export class SidebarNavComponent {
  readonly sections = input<NavSection[]>([]);
  readonly collapsed = input(false, { transform: booleanAttribute });
  readonly itemActivated = output<NavItem>();
}
