import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import {
  ButtonComponent,
  DvErrorBubbleComponent,
  DvSystemPillComponent,
  IconComponent,
} from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';
import { LucideRefreshCw } from '@lucide/angular';
import type { ChatBubbleMessage } from '../../models/chat-bubble-contract.model';
import { errorCardMeta } from './utils/message-bubble.utils';
import { UserTurnComponent } from './components/user-turn/user-turn.component';
import { AssistantTurnComponent } from './components/assistant-turn/assistant-turn.component';
import { OutboxCardComponent } from './components/outbox-card/outbox-card.component';

@Component({
  selector: 'ds-message-bubble',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    DvErrorBubbleComponent,
    DvSystemPillComponent,
    IconComponent,
    TranslateModule,
    UserTurnComponent,
    AssistantTurnComponent,
    OutboxCardComponent,
  ],
  templateUrl: './message-bubble.component.html',
  styleUrl: './message-bubble.component.scss',
})
export class MessageBubbleComponent {
  readonly LucideRefreshCw = LucideRefreshCw;

  readonly msg = input.required<ChatBubbleMessage>();
  /** True only for the newest conversation item; older assistant avatars stay still. */
  readonly isLatest = input(true);
  /** Emitted when the user clicks "Retry" on an error system message. */
  readonly retry = output<void>();
  /** Emitted when the user clicks "Continue" on an error system message —
   *  the chat panel auto-sends a localized "an error occurred, continue". */
  readonly continueRun = output<void>();

  /**
   * Whether to render the Retry button on a system message.
   * REV-AGENT-CORE-011: user-initiated cancellation hides Retry — the user
   * explicitly chose to stop, there is nothing to retry. Idle and
   * question_timeout cancellations DO show Retry. Classified errors also show it.
   */
  readonly showRetry = computed(() => {
    const m = this.msg();
    if (m.cancelReason === 'user') return false;
    return !!(m.errorClassification || m.cancelReason);
  });

  /**
   * Returns the error card display data when msg has an errorClassification,
   * otherwise null (falls back to the plain divider line).
   */
  readonly errorCardData = computed<{ titleKey: string } | null>(() => {
    const ec = this.msg().errorClassification;
    return ec ? errorCardMeta(ec) : null;
  });
}
