import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { DvDiffLine } from '../models';

@Component({
  selector: 'dv-diff-view',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DvDiffViewComponent {
  readonly fileName = input('');
  readonly lines = input.required<DvDiffLine[]>();
}
