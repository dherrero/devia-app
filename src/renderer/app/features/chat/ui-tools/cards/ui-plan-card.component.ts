import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonComponent } from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';

import type { PlanApproveInput, PlanApproveResult } from '../../../../../../shared/domain/ui-tools';
import { MarkdownRendererService } from '../../chat-panel/services/markdown-renderer.service';

/**
 * Plan submitted by the agent through `devia_plan_approve` (S-25 F2.2).
 *
 * Presentational: it emits the decision and never touches the API. Switching
 * the session to apply mode and queueing the follow-up run are the panel's job,
 * because only the panel knows this pane's run identity.
 */
@Component({
  selector: 'ds-ui-plan-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, FormsModule, TranslateModule],
  templateUrl: './ui-plan-card.component.html',
  styleUrl: './ui-plan-card.component.scss',
})
export class UiPlanCardComponent {
  private readonly markdown = inject(MarkdownRendererService);

  readonly input = input.required<unknown>();
  /** Stable per call, so the markdown cache does not collide across cards. */
  readonly callId = input.required<string>();
  readonly decided = output<PlanApproveResult>();

  protected readonly plan = computed<PlanApproveInput | null>(() => {
    const value = this.input() as PlanApproveInput | null;
    return value && typeof value.plan === 'string' ? value : null;
  });

  protected readonly body = computed(() =>
    this.markdown.render(`plan:${this.callId()}`, this.plan()?.plan ?? ''),
  );

  protected readonly rejecting = signal(false);
  protected readonly comment = signal('');

  /** A rejection without a reason makes the agent re-propose the same thing. */
  protected readonly canReject = computed(() => this.comment().trim().length > 0);

  protected approve(): void {
    this.decided.emit({ decision: 'approve' });
  }

  protected approveAndRun(): void {
    this.decided.emit({ decision: 'approve_and_run' });
  }

  protected startReject(): void {
    this.rejecting.set(true);
  }

  protected cancelReject(): void {
    this.rejecting.set(false);
    this.comment.set('');
  }

  protected confirmReject(): void {
    if (!this.canReject()) return;
    this.decided.emit({ decision: 'reject', comment: this.comment().trim() });
  }

  protected onCommentInput(value: string): void {
    this.comment.set(value);
  }
}
