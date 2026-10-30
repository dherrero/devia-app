import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

@Component({
  selector: 'dv-output-log',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OutputLogComponent {
  readonly lines = input<ReadonlyArray<string>>([]);
  readonly maxLines = input(400);
  readonly ariaLabel = input('Output log');
  readonly emptyText = input<string | null>(null);

  readonly visibleLines = computed(() => {
    const lines = this.lines();
    const max = Math.max(1, this.maxLines());
    return lines.length > max ? lines.slice(-max) : lines;
  });

  readonly text = computed(() => this.visibleLines().join('\n'));
}
