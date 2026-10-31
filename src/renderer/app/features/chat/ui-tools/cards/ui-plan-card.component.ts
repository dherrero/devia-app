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

  protected readonly keepPlanning = signal(false);
  protected readonly comment = signal('');

  /** Accept and let the agent ask before each action (apply mode). */
  protected approveAndRun(): void {
    this.decided.emit({ decision: 'approve_and_run' });
  }

  /** Accept and run without permission prompts (apply-yolo mode). */
  protected approveAndRunYolo(): void {
    this.decided.emit({ decision: 'approve_and_run_yolo' });
  }

  protected startKeepPlanning(): void {
    this.keepPlanning.set(true);
  }

  protected cancelKeepPlanning(): void {
    this.keepPlanning.set(false);
    this.comment.set('');
  }

  /** The comment is optional: the user may just want another pass. */
  protected confirmKeepPlanning(): void {
    const comment = this.comment().trim();
    this.decided.emit({ decision: 'keep_planning', ...(comment ? { comment } : {}) });
  }

  protected onCommentInput(value: string): void {
    this.comment.set(value);
  }
}
