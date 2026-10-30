import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { DvChatMessageComponent } from '../chat-message/component';
import type { DvChatMessage, DvChoiceOption } from '../models';

@Component({
  selector: 'dv-chat-feed',
  imports: [DvChatMessageComponent],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DvChatFeedComponent {
  readonly messages = input<DvChatMessage[]>([]);
  readonly ariaLabel = input('Conversacion');
  readonly choiceSelected = output<DvChoiceOption>();
  readonly retry = output<DvChatMessage>();
}
