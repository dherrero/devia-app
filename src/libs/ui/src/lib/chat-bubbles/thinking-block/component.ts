import {
  ChangeDetectionStrategy,
  Component,
  input,
  signal,
} from '@angular/core';

@Component({
  selector: 'dv-thinking-block',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DvThinkingBlockComponent {
  readonly label = input('Razonando');
  readonly content = input.required<string>();
  readonly isOpen = signal(false);

  toggle(): void {
    this.isOpen.update((value) => !value);
  }
}
