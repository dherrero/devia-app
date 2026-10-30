import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DvAiBubbleComponent } from '../ai-bubble/component';

@Component({
  selector: 'dv-streaming-indicator',
  imports: [DvAiBubbleComponent],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DvStreamingIndicatorComponent {
  readonly label = input('Claude trabajando');
  readonly ariaLabel = input('Claude esta escribiendo');
}
