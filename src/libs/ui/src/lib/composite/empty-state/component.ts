import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'dv-empty-state',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dv-empty-state' },
})
export class EmptyStateComponent {
  readonly title = input.required<string>();
  readonly body = input<string | null>(null);
}
