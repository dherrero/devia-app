import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { IconComponent } from '@devia/ui';
import { LucideMessageSquare } from '@lucide/angular';
import { TranslateModule } from '@ngx-translate/core';
import type { ChatMessage } from '../../../../../../../shared/domain/chat';
import type { QuestionAskEvent } from '../../../../../../types/devia';
import { MessageBubbleComponent } from '../message-bubble/message-bubble.component';
import { HandoffDividerComponent } from '../handoff-divider/handoff-divider.component';
import { PlanMessageComponent } from '../plan-message/plan-message.component';
import { UiTodoCardComponent } from '../../../ui-tools/cards/ui-todo-card.component';
import { QuestionCardComponent } from '../question-card/question-card.component';
import { ChatScrollService } from '../../services/chat-scroll.service';

/**
 * Messages scroller (HT-CH-03). Owns the auto-follow scroll surface, the
 * empty-state placeholder and the inline `ResizeObserver` that re-pins
 * to the bottom while the user's intent is "stick to bottom".
 *
 * The host registers its native element with `ChatScrollService` so the
 * parent's FAB and composer `autosizeInput` can re-pin without holding
 * a `viewChild` of this component. Unregistering on destroy avoids
 * stale scroll targets when the chat view toggles.
 *
 * Inputs are direct arrays/objects (not signals) so the parent can pass
 * `currentMessages()` / `currentStream()` from its own computeds without
 * leaking signal types across the boundary.
 */
@Component({
  selector: 'ds-messages-feed',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IconComponent,
    TranslateModule,
    MessageBubbleComponent,
    HandoffDividerComponent,
    QuestionCardComponent,
    UiTodoCardComponent,
    PlanMessageComponent,
  ],
  templateUrl: './messages-feed.component.html',
  styleUrl: './messages-feed.component.scss',
  host: { class: 'ds-messages-feed' },
})
export class MessagesFeedComponent implements OnDestroy {
  readonly messages = input<readonly ChatMessage[]>([]);
  readonly stream = input<ChatMessage | null>(null);
  readonly hasOlder = input(false);
  /** Pending AskUserQuestion for the active project — rendered as the last
   *  bubble in the feed so the question sits inside the conversation. */
  readonly pendingQuestion = input<QuestionAskEvent | null>(null);

  readonly retry = output<void>();
  readonly continueRun = output<void>();
  readonly loadOlder = output<HTMLElement>();
  readonly answer = output<string>();
  readonly freeform = output<void>();

  protected readonly LucideMessageSquare = LucideMessageSquare;

  private readonly scroll = inject(ChatScrollService);

  private readonly scrollEl = viewChild<ElementRef<HTMLDivElement>>('scrollEl');
  private readonly innerEl = viewChild<ElementRef<HTMLDivElement>>('innerEl');
  private readonly topSentinelEl = viewChild<ElementRef<HTMLDivElement>>('topSentinelEl');

  private resizeObserver: ResizeObserver | null = null;
  private sentinelObserver: IntersectionObserver | null = null;
  private resizeFrame: number | null = null;

  constructor() {
    // Register / re-register the scroll container whenever it mounts.
    effect(() => {
      const el = this.scrollEl()?.nativeElement ?? null;
      this.scroll.setContainer(el);
    });

    // Content-driven stick-to-bottom. Re-pinning on layout settle (after
    // markdown render, code highlighting, image loads) is the only
    // reliable way to keep the freshest message in view — a single rAF
    // after the messages signal change measures too early. Recompute the
    // FAB here too because growing content while scrolled-up emits no
    // scroll event.
    effect(() => {
      const inner = this.innerEl()?.nativeElement;
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      if (!inner || typeof ResizeObserver === 'undefined') return;
      this.resizeObserver = new ResizeObserver(() => {
        if (this.resizeFrame !== null) return;
        this.resizeFrame = requestAnimationFrame(() => {
          this.resizeFrame = null;
          if (this.scroll.stickToBottom()) this.scroll.pin();
          else this.scroll.computeFab();
        });
      });
      this.resizeObserver.observe(inner);
    });

    effect(() => {
      this.sentinelObserver?.disconnect();
      this.sentinelObserver = null;
      const sentinel = this.topSentinelEl()?.nativeElement;
      const scroller = this.scrollEl()?.nativeElement;
      if (!sentinel || !scroller || typeof IntersectionObserver === 'undefined') return;
      this.sentinelObserver = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) this.loadOlder.emit(scroller);
        },
        { root: scroller, threshold: 0 },
      );
      this.sentinelObserver.observe(sentinel);
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.sentinelObserver?.disconnect();
    if (this.resizeFrame !== null) cancelAnimationFrame(this.resizeFrame);
    this.scroll.setContainer(null);
  }

  protected onScroll(): void {
    this.scroll.markFromScroll();
  }

  protected onRetry(): void {
    this.retry.emit();
  }

  protected onContinueRun(): void {
    this.continueRun.emit();
  }
}
