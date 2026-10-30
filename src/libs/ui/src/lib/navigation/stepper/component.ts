import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  TemplateRef,
  computed,
  contentChild,
  inject,
  input,
  model,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ProgressComponent } from '../../atoms/progress';

export type StepperStepState = 'pending' | 'active' | 'done';

export interface StepperStep {
  id: string;
  label: string;
  state: StepperStepState;
  /** One-line notes shown under the step, e.g. what the user answered in it. */
  notes?: readonly string[];
}

export interface StepperContentContext {
  $implicit: StepperStep;
}

/**
 * Marks the template rendered inside the ACTIVE step:
 * `<ng-template dvStepContent let-step>…</ng-template>`.
 */
@Directive({ selector: 'ng-template[dvStepContent]' })
export class StepperContentDirective {
  readonly template = inject<TemplateRef<StepperContentContext>>(TemplateRef);
}

/**
 * Read-only vertical stepper: shows where a multi-step process is, it does
 * not drive it. Whoever feeds `steps` decides which one is active.
 *
 * Deliberately NOT built on `CdkStepper`: that brings selectable headers and
 * keyboard navigation between steps, which is exactly what a progress view
 * whose steps advance on their own must not offer. An ordered list with
 * `aria-current="step"` is the right semantics here.
 *
 * Collapsed, it is a single line — `progressLabel` plus the active step and a
 * progress bar. Labels arrive as inputs because this library has no i18n.
 */
@Component({
  selector: 'dv-stepper',
  imports: [NgTemplateOutlet, ProgressComponent],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'dv-stepper',
    '[class.dv-stepper--collapsed]': 'collapsed()',
  },
})
export class StepperComponent {
  readonly steps = input<readonly StepperStep[]>([]);
  readonly collapsed = model(true);
  /** e.g. "Paso 2/5". Built by the caller, already translated. */
  readonly progressLabel = input('');
  readonly expandLabel = input('Expand');
  readonly collapseLabel = input('Collapse');
  readonly ariaLabel = input('');

  protected readonly content = contentChild(StepperContentDirective);

  protected readonly activeStep = computed<StepperStep | null>(() => {
    const steps = this.steps();
    return (
      steps.find((s) => s.state === 'active') ??
      steps.find((s) => s.state === 'pending') ??
      null
    );
  });

  protected readonly doneCount = computed(
    () => this.steps().filter((s) => s.state === 'done').length,
  );

  protected readonly percent = computed(() => {
    const total = this.steps().length;
    return total === 0 ? 0 : Math.round((this.doneCount() / total) * 100);
  });

  protected toggle(): void {
    this.collapsed.update((v) => !v);
  }
}
