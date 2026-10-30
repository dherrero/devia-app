import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { DvChatAvatarComponent } from '../chat-avatar/component';

@Component({
  selector: 'dv-error-bubble',
  imports: [DvChatAvatarComponent],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DvErrorBubbleComponent {
  readonly message = input.required<string>();
  readonly detail = input('');
  readonly avatarImageSrc = input<string | null>(null);
  readonly retryLabel = input('Reintentar');
  readonly showRetry = input(true);
  readonly retry = output<void>();

  readonly continueLabel = input('Continuar');
  readonly showContinue = input(false);
  readonly continueRun = output<void>();
}
