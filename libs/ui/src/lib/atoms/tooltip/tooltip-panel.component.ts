import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'dv-tooltip-panel',
  template: `<span class="dv-tooltip__text">{{ text() }}</span>`,
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'dv-tooltip',
    role: 'tooltip',
  },
})
export class TooltipPanelComponent {
  readonly text = input<string>('');
}
