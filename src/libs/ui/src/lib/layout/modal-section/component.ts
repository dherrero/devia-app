import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

@Component({
  selector: 'dv-modal-section',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClass()',
  },
})
export class ModalSectionComponent {
  readonly title = input.required<string>();
  readonly description = input<string | null>(null);
  readonly compact = input(false);

  readonly hostClass = computed(
    () =>
      `dv-modal-section${this.compact() ? ' dv-modal-section--compact' : ''}`,
  );
}
