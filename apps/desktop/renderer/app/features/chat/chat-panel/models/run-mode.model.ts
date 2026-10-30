/**
 * Run-mode of the agent the user can pick via the Plan / Apply / YOLO
 * segmented control (REV-AGENT-CORE-006, spec PART-06).
 *
 * - `plan`       — agent reads but never writes; produces a plan.
 * - `apply`      — agent edits files with implicit user approval.
 * - `apply-yolo` — agent skips ALL confirmations. Visually marked as
 *                   dangerous in the UI (red border + tint).
 */
export type RunMode = 'plan' | 'apply' | 'apply-yolo';

export interface RunModeOption {
  readonly id: RunMode;
  /** i18n key for the visible label (lives in `assets/i18n/*.json`). */
  readonly labelKey: string;
  /** i18n key for the tooltip on the segment. */
  readonly tooltipKey: string;
  /** Tint variant — `danger` paints YOLO with red. */
  readonly tone: 'default' | 'danger';
}

export const RUN_MODE_OPTIONS: readonly RunModeOption[] = [
  { id: 'plan',       labelKey: 'mode.plan_label',  tooltipKey: 'mode.plan_tooltip',  tone: 'default' },
  { id: 'apply',      labelKey: 'mode.apply_label', tooltipKey: 'mode.apply_tooltip', tone: 'default' },
  { id: 'apply-yolo', labelKey: 'mode.yolo_label',  tooltipKey: 'mode.yolo_tooltip',  tone: 'danger'  },
];
