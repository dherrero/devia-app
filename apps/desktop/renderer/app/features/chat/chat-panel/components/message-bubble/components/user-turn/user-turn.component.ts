import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DvUserBubbleComponent } from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';
import type { ChatBubbleMessage } from '../../../../models/chat-bubble-contract.model';
import { timeFromId } from '../../utils/message-bubble.utils';

@Component({
  selector: 'ds-user-turn',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DvUserBubbleComponent, TranslateModule],
  templateUrl: './user-turn.component.html',
  styleUrl: './user-turn.component.scss',
})
export class UserTurnComponent {
  readonly msg = input.required<ChatBubbleMessage>();

  readonly when = computed(() => timeFromId(this.msg().id));
}
