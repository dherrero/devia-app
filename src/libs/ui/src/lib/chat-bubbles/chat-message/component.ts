import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { DvAiBubbleComponent } from '../ai-bubble/component';
import { DvChoiceCardComponent } from '../choice-card/component';
import { DvDiffViewComponent } from '../diff-view/component';
import { DvErrorBubbleComponent } from '../error-bubble/component';
import type { DvChatMessage, DvChoiceOption } from '../models';
import { DvStreamingIndicatorComponent } from '../streaming-indicator/component';
import { DvSystemPillComponent } from '../system-pill/component';
import { DvThinkingBlockComponent } from '../thinking-block/component';
import { DvToolCallCardComponent } from '../tool-call-card/component';
import { DvUserBubbleComponent } from '../user-bubble/component';

@Component({
  selector: 'dv-chat-message',
  imports: [
    DvAiBubbleComponent,
    DvChoiceCardComponent,
    DvDiffViewComponent,
    DvErrorBubbleComponent,
    DvStreamingIndicatorComponent,
    DvSystemPillComponent,
    DvThinkingBlockComponent,
    DvToolCallCardComponent,
    DvUserBubbleComponent,
  ],
  templateUrl: './component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DvChatMessageComponent {
  readonly message = input.required<DvChatMessage>();
  readonly choiceSelected = output<DvChoiceOption>();
  readonly retry = output<void>();
}
