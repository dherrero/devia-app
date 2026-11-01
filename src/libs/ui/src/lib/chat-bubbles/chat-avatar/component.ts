import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

export type DvChatAvatarVariant = 'user' | 'ai';

/**
 * Agent activity reflected on the assistant avatar:
 * Mirrors the 15-state design prototype. Consumers can use the full contract,
 * while chat surfaces derive the subset they can infer from run/tool events.
 */
export type DvChatAvatarState =
  | 'idle'
  | 'paused'
  | 'offline'
  | 'listening'
  | 'asking'
  | 'thinking'
  | 'planning'
  | 'searching'
  | 'tool'
  | 'writing'
  | 'terminal'
  | 'streaming'
  | 'success'
  | 'error'
  | 'warning';

/** One mouth pose: eyes-open frame plus its closed-eye twin. */
export interface DvChatAvatarFramePair {
  open: string;
  blink: string;
}

/** Mouth poses used to fake speech while the agent is writing. */
export interface DvChatAvatarSpeakFrames {
  consonants: DvChatAvatarFramePair;
  a: DvChatAvatarFramePair;
  ei: DvChatAvatarFramePair;
  ou: DvChatAvatarFramePair;
}

@Component({
  selector: 'dv-chat-avatar',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClass()',
    '[attr.aria-label]': 'ariaLabel()',
    '[attr.data-state]': 'state()',
    '[attr.data-active]': 'active() ? "true" : "false"',
  },
})
export class DvChatAvatarComponent {
  readonly variant = input<DvChatAvatarVariant>('user');
  readonly label = input('U');
  readonly ariaLabel = input<string | null>(null);
  /** When set, the avatar renders this image instead of the text label. */
  readonly imageSrc = input<string | null>(null);
  /** Optional closed-eye frame; when present the avatar blinks (CSS-driven). */
  readonly blinkSrc = input<string | null>(null);
  /** Agent activity; drives the status ring/badge on the assistant avatar. */
  readonly state = input<DvChatAvatarState>('idle');
  /** Only the latest assistant message should animate; history stays still. */
  readonly active = input(true);
  /** Mouth frames cycled while the agent streams text (simulated speech). */
  readonly speakFrames = input<DvChatAvatarSpeakFrames | null>(null);

  /** True only for the live avatar while text is streaming. */
  readonly speaking = computed(
    () => this.state() === 'streaming' && this.active() && !!this.speakFrames(),
  );

  readonly hostClass = computed(
    () => `dv-chat-avatar dv-chat-avatar--${this.variant()}`,
  );
}
