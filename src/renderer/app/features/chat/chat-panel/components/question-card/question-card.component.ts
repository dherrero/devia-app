import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { ButtonComponent, DvAiBubbleComponent, IconComponent } from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';
import { LucidePlus } from '@lucide/angular';
import type { QuestionAskEvent, QuestionOption, QuestionPrompt } from '../../../../../../types/devia';

type SelectionMap = Record<string, readonly string[]>;
type RenderQuestionPrompt = QuestionPrompt & { key: string; multiSelect: boolean };

/**
 * Inline question card rendered above the chat input box when an agent emits an
 * AskUserQuestion tool call. When the tool input carried discrete options they
 * render as clickable pills (audit v2 · 06-question-card); clicking one submits
 * that label as the answer. With no options the user types a free-form reply in
 * the normal input bar.
 *
 * REV-TS-CLI-05-03: reads `pendingQuestion` from AppStateService via an input
 * signal rather than injecting the service so it can be tested without TestBed
 * and reused outside the chat panel. The chosen option is forwarded to the
 * parent via `(answer)` rather than calling the API directly, keeping the card
 * a pure presentational component.
 */
@Component({
  selector: 'ds-question-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DvAiBubbleComponent, IconComponent, TranslateModule],
  templateUrl: './question-card.component.html',
  styleUrl: './question-card.component.scss',
})
export class QuestionCardComponent {
  readonly LucidePlus = LucidePlus;
  /** Null or the current pending question for the selected project. */
  readonly question = input<QuestionAskEvent | null>(null);
  /** Emitted with the chosen option label when the user clicks an option pill. */
  readonly answer = output<string>();
  /** Emitted when the user wants to type a free-form answer (focuses the composer). */
  readonly freeform = output<void>();
  protected readonly selected = signal<SelectionMap>({});

  protected readonly prompts = computed<RenderQuestionPrompt[]>(() => {
    const question = this.question();
    if (!question) return [];
    const source = question.questions?.length
      ? question.questions
      : [{ id: 'q1', question: question.question, ...(question.options ? { options: question.options } : {}) }];
    return source.map((prompt, index) => ({
      ...prompt,
      key: `${question.toolUseId}:${prompt.id ?? index}`,
      multiSelect: prompt.multiSelect === true,
    }));
  });

  protected readonly requiresSubmit = computed(() =>
    this.prompts().length > 1 || this.prompts().some((prompt) => prompt.multiSelect),
  );

  protected readonly canSubmit = computed(() => {
    const promptsWithOptions = this.prompts().filter((prompt) => (prompt.options?.length ?? 0) > 0);
    if (promptsWithOptions.length === 0) return false;
    return promptsWithOptions.every((prompt) => (this.selected()[prompt.key]?.length ?? 0) > 0);
  });

  protected selectOption(prompt: RenderQuestionPrompt, option: QuestionOption): void {
    if (!this.requiresSubmit()) {
      this.answer.emit(option.label);
      return;
    }

    this.selected.update((current) => {
      const existing = current[prompt.key] ?? [];
      const next = prompt.multiSelect
        ? existing.includes(option.label)
          ? existing.filter((value) => value !== option.label)
          : [...existing, option.label]
        : [option.label];
      return { ...current, [prompt.key]: next };
    });
  }

  protected isSelected(prompt: RenderQuestionPrompt, option: QuestionOption): boolean {
    return (this.selected()[prompt.key] ?? []).includes(option.label);
  }

  protected submitSelections(): void {
    if (!this.canSubmit()) return;
    const lines = this.prompts()
      .map((prompt) => {
        const values = this.selected()[prompt.key] ?? [];
        if (values.length === 0) return null;
        const label = prompt.header ?? prompt.question;
        return `${label}: ${values.join(', ')}`;
      })
      .filter((line): line is string => line !== null);
    if (lines.length === 0) return;
    this.answer.emit(lines.length === 1 ? lines[0] : lines.join('\n'));
  }
}
