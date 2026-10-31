import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

import type { ChatMessage } from '../../../../../../../shared/domain/chat';
import type { PlanRecord } from '../../../../../../../shared/domain/ui-tools';
import { MarkdownRendererService, type RenderedMarkdown } from '../../services/markdown-renderer.service';

/**
 * A plan the user already decided on (S-28 T-337), rendered in the thread
 * instead of a bubble for `msg.kind === 'plan'`.
 *
 * Read-only on purpose: the decision is history. The live, answerable card is
 * `ds-ui-plan-card` above the composer, and it goes away once answered.
 * Collapsed by default so a long plan does not bury the conversation.
 */
@Component({
  selector: 'ds-plan-message',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslateModule],
  templateUrl: './plan-message.component.html',
  styleUrl: './plan-message.component.scss',
})
export class PlanMessageComponent {
  private readonly markdown = inject(MarkdownRendererService);

  readonly msg = input.required<ChatMessage>();

  protected readonly expanded = signal(false);

  protected readonly plan = computed<PlanRecord | null>(() => this.msg().plan ?? null);

  /** Not an approval: the plan was rejected or the user chose to keep planning. */
  protected readonly rejected = computed(() => {
    const decision = this.plan()?.decision;
    return decision === 'reject' || decision === 'keep_planning';
  });

  protected readonly verdictKey = computed(() => {
    switch (this.plan()?.decision) {
      case 'reject':
        return 'ui_tools.plan.decided_rejected';
      case 'keep_planning':
        return 'ui_tools.plan.decided_keep_planning';
      case 'approve_and_run_yolo':
        return 'ui_tools.plan.decided_yolo';
      default:
        return 'ui_tools.plan.decided_approved';
    }
  });

  protected readonly commentKey = computed(() =>
    this.plan()?.decision === 'keep_planning' ? 'ui_tools.plan.keep_comment' : 'ui_tools.plan.reject_reason',
  );

  protected readonly body = computed<RenderedMarkdown>(() =>
    this.markdown.render(`plan-msg-${this.msg().id}`, this.plan()?.plan ?? ''),
  );

  protected toggle(): void {
    this.expanded.update((v) => !v);
  }
}
