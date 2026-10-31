import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { StepperComponent, StepperContentDirective, type StepperStep } from '@devia/ui';
import { NgTemplateOutlet } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

import {
  buildPlanFollowUpPrompt,
  isPlanRunDecision,
  renderConfirmResult,
  renderPickResult,
  type ConfirmInput,
  type ConfirmResult,
  type PickResult,
  type PlanApproveResult,
} from '../../../../../shared/domain/ui-tools';
import { UiConfirmCardComponent } from './cards/ui-confirm-card.component';
import { UiPickCardComponent } from './cards/ui-pick-card.component';
import { UiPlanCardComponent } from './cards/ui-plan-card.component';
import { UiToolsService, type PendingUiTool, type StepNote } from './ui-tools.service';

/**
 * A run Devia must start on the user's behalf once a card is resolved.
 *
 * The host cannot submit it itself: only the chat panel knows this pane's run
 * identity (base checkout, runKey, isolation, sessionId), and duplicating that
 * here would be a second source of truth for how a run is launched.
 */
export interface UiFollowUpRun {
  /** Sent to the agent — English, like every other instruction Devia composes. */
  prompt: string;
  /** Shown in the thread as the user's message — Spanish. */
  displayText: string;
  mode: 'plan' | 'apply' | 'apply-yolo';
}

/** Tools whose card this host draws. `request_review` is the Cambios view. */
const CARD_TOOLS = new Set(['confirm', 'pick']);

/**
 * The execution panel above the composer (S-28 T-339; S-25 F2.0 before it).
 *
 * Three shapes, never more than one at a time:
 *  - **proposal** — a plan is waiting for a decision: only its card shows;
 *  - **executing** — the run has a step list: a stepper, collapsed to one line,
 *    that opens by itself when a step needs an answer and draws that card
 *    INSIDE the step; once answered the card becomes a one-line note;
 *  - **loose** — no plan and no list: the waiting card alone, compact.
 *
 * It sits BETWEEN the message list and the composer, outside the windowed feed
 * (S-4 T-75) so it can never disturb the bottom anchoring or the top sentinel's
 * IntersectionObserver.
 */
@Component({
  selector: 'ds-ui-tool-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    TranslateModule,
    StepperComponent,
    StepperContentDirective,
    UiPlanCardComponent,
    UiConfirmCardComponent,
    UiPickCardComponent,
  ],
  templateUrl: './ui-tool-host.component.html',
  styleUrl: './ui-tool-host.component.scss',
})
export class UiToolHostComponent {
  private readonly uiTools = inject(UiToolsService);
  private readonly translate = inject(TranslateService);

  /** `runKey ?? effectiveProject` — the pane that owns the run. */
  readonly sessionKey = input.required<string>();
  /** The checkout the run is against — cards that browse files need it. */
  readonly project = input<string>('');

  /** Emitted when resolving a card requires Devia to start a run. */
  readonly followUp = output<UiFollowUpRun>();

  private readonly requests = computed<PendingUiTool[]>(
    () => this.uiTools.pendingUiRequests()[this.sessionKey()] ?? [],
  );

  protected readonly planRequest = computed(
    () => this.requests().find((r) => r.tool === 'plan_approve') ?? null,
  );

  /** Cards waiting for the user, oldest first. */
  protected readonly cards = computed(() => this.requests().filter((r) => CARD_TOOLS.has(r.tool)));

  private readonly execution = computed(
    () => this.uiTools.executionStates()[this.sessionKey()] ?? null,
  );

  protected readonly steps = computed<StepperStep[]>(() => {
    const exec = this.execution();
    if (!exec) return [];
    return exec.steps.map((item) => ({
      id: item.id,
      label: item.text,
      state: item.status === 'done' ? 'done' : item.status === 'in_progress' ? 'active' : 'pending',
      notes: (exec.notes[item.id] ?? []).map((n) => this.noteText(n)),
    }));
  });

  /** A step the cards can be drawn in; with every step done they go loose. */
  protected readonly hasOpenStep = computed(() => this.steps().some((s) => s.state !== 'done'));

  protected readonly progressLabel = computed(() => {
    const steps = this.steps();
    const done = steps.filter((s) => s.state === 'done').length;
    const current = Math.min(done + 1, steps.length);
    return this.translate.instant('ui_tools.panel.progress', { current, total: steps.length }) as string;
  });

  protected readonly collapsed = signal(true);

  constructor() {
    // Open by itself when a step needs an answer, fold back once nothing does.
    // The user can still open or close it by hand in between.
    let hadCards = false;
    effect(() => {
      const hasCards = this.cards().length > 0;
      if (hasCards !== hadCards) this.collapsed.set(!hasCards);
      hadCards = hasCards;
    });
  }

  protected onPickDecided(request: PendingUiTool, result: PickResult): void {
    const note: StepNote =
      result.paths.length > 0
        ? { kind: 'picked', detail: result.paths.join(', ') }
        : { kind: 'pick_cancelled', detail: '' };
    this.uiTools.resolve(this.sessionKey(), request.callId, renderPickResult(result), note);
  }

  protected onConfirmDecided(request: PendingUiTool, result: ConfirmResult): void {
    // Persisting an "always" is main's job: it owns the per-project store and
    // knows which action the call was about.
    const action = (request.input as ConfirmInput | null)?.action ?? '';
    const kind = result.decision === 'yes' ? 'confirmed' : result.decision === 'always' ? 'always' : 'declined';
    this.uiTools.resolve(this.sessionKey(), request.callId, renderConfirmResult(result), { kind, detail: action });
  }

  protected onPlanDecided(request: PendingUiTool, result: PlanApproveResult): void {
    // Resolve FIRST (inside resolvePlan): the agent is blocked on this call,
    // and the follow-up run can only dispatch once its turn ends. The decided
    // plan lands in the thread before the follow-up's own message.
    const plan = this.uiTools.resolvePlan(this.sessionKey(), request.callId, result);

    // `keep_planning` launches nothing: the agent is still in this turn and
    // refines the plan once the tool result reaches it.
    if (!isPlanRunDecision(result.decision) || !plan) return;
    const yolo = result.decision === 'approve_and_run_yolo';
    this.followUp.emit({
      prompt: buildPlanFollowUpPrompt(plan, yolo),
      displayText: `Ejecuta el plan aprobado${yolo ? ' (sin preguntar)' : ''}: ${plan.title}`,
      mode: yolo ? 'apply-yolo' : 'apply',
    });
  }

  private noteText(note: StepNote): string {
    return this.translate.instant(`ui_tools.panel.note_${note.kind}`, { detail: note.detail }) as string;
  }
}
