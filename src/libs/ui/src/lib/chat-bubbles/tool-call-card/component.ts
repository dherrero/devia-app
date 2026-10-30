import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';
import { DvChatStatusBadgeComponent } from '../chat-status-badge/component';
import type { DvToolStatus } from '../models';

@Component({
  selector: 'dv-tool-call-card',
  imports: [DvChatStatusBadgeComponent],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DvToolCallCardComponent {
  readonly name = input.required<string>();
  readonly arg = input('');
  readonly status = input<DvToolStatus>('pending');
  readonly body = input('');

  readonly isOpen = signal(false);

  readonly ariaLabel = computed(() => {
    const arg = this.arg();
    return arg ? `${this.name()} - ${arg}` : this.name();
  });

  readonly statusLabel = computed(() => this.status().toUpperCase());

  toggle(): void {
    this.isOpen.update((value) => !value);
  }
}
