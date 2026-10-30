import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import type { DvChoiceOption } from '../models';

@Component({
  selector: 'dv-choice-card',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DvChoiceCardComponent {
  readonly label = input('Opciones');
  readonly question = input.required<string>();
  readonly options = input.required<DvChoiceOption[]>();
  readonly selected = output<DvChoiceOption>();
}
