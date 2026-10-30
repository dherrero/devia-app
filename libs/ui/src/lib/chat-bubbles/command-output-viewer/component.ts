import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';
import { enrichTextLines, parseCommandOutput } from './output-parser';

@Component({
  selector: 'dv-command-output-viewer',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.dv-command-output-viewer--error]': 'isError()',
  },
})
export class DvCommandOutputViewerComponent {
  readonly content = input.required<string>();
  readonly isError = input(false);
  readonly command = input('');
  readonly maxPreviewLines = input(120);
  readonly rawLabel = input('Raw');
  readonly richLabel = input('Rich');
  readonly fullLabel = input('Full');
  readonly previewLabel = input('Preview');

  readonly showRaw = signal(false);
  readonly expanded = signal(false);

  readonly isLong = computed(
    () =>
      this.content().replace(/\r\n/g, '\n').split('\n').length >
      this.maxPreviewLines(),
  );

  readonly displayedContent = computed(() => {
    const content = this.content();
    if (this.expanded() || !this.isLong()) return content;

    return (
      content
        .replace(/\r\n/g, '\n')
        .split('\n')
        .slice(0, this.maxPreviewLines())
        .join('\n') + '\n...[truncated]'
    );
  });

  readonly model = computed(() =>
    parseCommandOutput(this.displayedContent(), { command: this.command() }),
  );

  textLines(content: string) {
    return enrichTextLines(content);
  }

  isNumericCell(value: string): boolean {
    return /^-?[\d.,]+(?:\s*(?:bytes|b|kb|mb|gb|tb|ms|s|%))?$/i.test(
      value.trim(),
    );
  }

  isPathLike(value: string): boolean {
    return /(?:^[A-Za-z]:[\\/]|[\\/][\w .-]+[\\/]|\.{1,2}[\\/])/.test(
      value.trim(),
    );
  }

  toggleRaw(): void {
    this.showRaw.update((value) => !value);
  }

  toggleExpanded(): void {
    this.expanded.update((value) => !value);
  }
}
