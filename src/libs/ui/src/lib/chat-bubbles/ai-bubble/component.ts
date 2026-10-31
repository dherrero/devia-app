import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import {
  DvChatAvatarComponent,
  type DvChatAvatarSpeakFrames,
  type DvChatAvatarState,
} from '../chat-avatar/component';

@Component({
  selector: 'dv-ai-bubble',
  imports: [DvChatAvatarComponent],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DvAiBubbleComponent {
  readonly content = input('');
  readonly avatarLabel = input('AI');
  /** When set, the avatar renders this image instead of the text label. */
  readonly avatarImageSrc = input<string | null>(null);
  /** Optional closed-eye frame forwarded to the avatar so it blinks. */
  readonly avatarBlinkSrc = input<string | null>(null);
  /** Mouth frames forwarded to the avatar so it "speaks" while streaming. */
  readonly avatarSpeakFrames = input<DvChatAvatarSpeakFrames | null>(null);
  /** Agent activity forwarded to the avatar's status ring/badge. */
  readonly avatarState = input<DvChatAvatarState>('idle');
  /** Whether this avatar is the live/latest one allowed to animate. */
  readonly avatarActive = input(true);
}
