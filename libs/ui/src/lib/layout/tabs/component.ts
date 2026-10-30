import {
  ChangeDetectionStrategy,
  Component,
  model,
  input,
  output,
  booleanAttribute,
} from '@angular/core';

export interface TabItem {
  id: string;
  label: string;
  disabled?: boolean;
  /** Optional accent count chip rendered to the right of the label. */
  badge?: number | string;
}

/**
 * Visual variant of `dv-tabs`.
 *
 * - `underline` (default) — traditional tablist with a 2px accent underline
 *   on the active tab. Matches material/web conventions.
 * - `pill` — segmented control: every tab lives inside a soft container
 *   (`--dv-surf-2`) and the active tab elevates with `--dv-shadow-sm`. Used
 *   by the desktop chat header (Chat | Cambios) per `DESKTOP-PART-03-CHAT-PANEL.md`.
 *
 * Both variants keep the same ARIA tab semantics and keyboard navigation,
 * so screen readers behave identically regardless of styling.
 */
export type TabsVariant = 'underline' | 'pill';

@Component({
  selector: 'dv-tabs',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'dv-tabs',
    '[class.dv-tabs--vertical]': `orientation() === 'vertical'`,
    '[class.dv-tabs--pill]': `variant() === 'pill'`,
  },
})
export class TabsComponent {
  readonly tabs = input<TabItem[]>([]);
  readonly value = model<string | null>(null);
  readonly orientation = input<'horizontal' | 'vertical'>('horizontal');
  readonly variant = input<TabsVariant>('underline');
  readonly useViewTransition = input(true, { transform: booleanAttribute });
  readonly valueChange = output<string>();

  protected selectTab(tab: TabItem): void {
    if (tab.disabled) return;
    this.value.set(tab.id);
    this.valueChange.emit(tab.id);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const enabledTabs = this.tabs().filter((t) => !t.disabled);
    const currentIdx = enabledTabs.findIndex((t) => t.id === this.value());
    let nextIdx = currentIdx;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIdx = (currentIdx + 1) % enabledTabs.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIdx = (currentIdx - 1 + enabledTabs.length) % enabledTabs.length;
    } else if (event.key === 'Home') {
      nextIdx = 0;
    } else if (event.key === 'End') {
      nextIdx = enabledTabs.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const next = enabledTabs[nextIdx];
    if (next) this.selectTab(next);
  }
}
