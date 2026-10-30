import {
  ChangeDetectionStrategy,
  Component,
  input,
  model,
} from '@angular/core';
import { type LucideIcon } from '@lucide/angular';
import { IconComponent } from '../../atoms/icon';
import { TooltipDirective } from '../../atoms/tooltip';

export interface ToggleItem {
  id: string;
  label?: string;
  icon?: LucideIcon;
  tooltip?: string;
  disabled?: boolean;
}

@Component({
  selector: 'dv-button-toggle-group',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TooltipDirective],
  template: `
    <div class="dvtg-root" role="group" [attr.aria-label]="ariaLabel()">
      @for (item of items(); track item.id) {
        <button
          type="button"
          class="dvtg-item"
          [class.is-active]="value() === item.id"
          [disabled]="item.disabled ?? false"
          [dvTooltip]="item.tooltip ?? ''"
          (click)="select(item.id)"
        >
          @if (item.icon) {
            <dv-icon [icon]="item.icon" size="sm" />
          }
          @if (item.label) {
            <span>{{ item.label }}</span>
          }
        </button>
      }
    </div>
  `,
  styles: [
    `
      .dvtg-root {
        display: inline-flex;
        gap: 0.125rem;
        padding: 0.25rem;
        background: var(--dv-surf-2);
        border: 1px solid var(--dv-bor);
        border-radius: 0.5rem;
      }

      .dvtg-item {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.375rem;
        padding: 0.375rem 0.625rem;
        border: none;
        border-radius: 0.375rem;
        background: transparent;
        color: var(--dv-muted);
        cursor: pointer;
        font-size: 0.875rem;
        font-family: inherit;
        transition:
          background 0.12s,
          color 0.12s;
        outline: none;

        &:hover:not(:disabled) {
          background: var(--dv-surf-3);
          color: var(--dv-fg);
        }

        &:focus-visible {
          outline: 2px solid var(--dv-acc);
          outline-offset: -1px;
        }

        &.is-active {
          background: var(--dv-acc-lo);
          color: var(--dv-acc);
        }

        &:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
      }
    `,
  ],
})
export class ButtonToggleGroupComponent {
  readonly items = input.required<ToggleItem[]>();
  readonly value = model<string>('');
  readonly ariaLabel = input('');

  select(id: string): void {
    this.value.set(id);
  }
}
