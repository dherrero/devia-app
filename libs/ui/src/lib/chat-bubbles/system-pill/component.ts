import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'dv-system-pill',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DvSystemPillComponent {
  readonly content = input.required<string>();
}
