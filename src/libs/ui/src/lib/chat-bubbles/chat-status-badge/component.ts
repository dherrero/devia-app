import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type { DvToolStatus } from '../models';

@Component({
  selector: 'dv-chat-status-badge',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClass()',
  },
})
export class DvChatStatusBadgeComponent {
  readonly status = input<DvToolStatus | 'neutral'>('neutral');

  readonly hostClass = computed(
    () => `dv-chat-status-badge dv-chat-status-badge--${this.status()}`,
  );
}
