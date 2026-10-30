import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DvChatAvatarComponent } from '../chat-avatar/component';

@Component({
  selector: 'dv-user-bubble',
  imports: [DvChatAvatarComponent],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DvUserBubbleComponent {
  readonly content = input.required<string>();
  readonly avatarLabel = input('U');
}
