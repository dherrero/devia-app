import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { IconComponent } from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';
import { LucideCheck } from '@lucide/angular';
import type { ToolCallRecord } from '../../../../../../../shared/domain/chat';
import {
  normalizeAskUserQuestionInput,
  resolveAskUserQuestionAnswers,
} from '../../../../../../../shared/domain/question-ask';

interface AnsweredOption {
  label: string;
  selected: boolean;
}

interface AnsweredPrompt {
  key: string;
  header: string | null;
  question: string;
  options: AnsweredOption[];
  /** The answer text when it matches no option (free-form reply). */
  freeAnswer: string | null;
  /** No answer survived for this prompt (e.g. a Claude session saved before the answer was recorded). */
  unrecorded: boolean;
}

/**
 * Read-only record of an answered AskUserQuestion, rendered inline in the
 * assistant bubble's content flow. The interactive card
 * (`QuestionCardComponent`) owns the question only while it is pending; once
 * answered, the transcript keeps the question and the user's selection here —
 * the answer never appears as a user message.
 *
 * The selection is derived from the tool call's `result` (Claude's canned
 * `"question"="answer"` sentence, or the raw answer Devia wrote for other
 * agents), so it survives reloads via the persisted event log.
 */
@Component({
  selector: 'ds-question-answered-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslateModule],
  templateUrl: './question-answered-card.component.html',
  styleUrl: './question-answered-card.component.scss',
})
export class QuestionAnsweredCardComponent {
  readonly LucideCheck = LucideCheck;

  readonly toolCall = input.required<ToolCallRecord>();

  protected readonly prompts = computed<AnsweredPrompt[]>(() => {
    const tc = this.toolCall();
    const normalized = normalizeAskUserQuestionInput(tc.input);
    const answers = resolveAskUserQuestionAnswers(normalized.questions, tc.result ?? '');
    return normalized.questions.map((prompt, index) => {
      const answer = (answers[prompt.question] ?? '').trim();
      // Multi-select answers arrive joined with ", " — match per value, but
      // try the whole string first so labels containing commas still match.
      const values = answer
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0);
      const options: AnsweredOption[] = (prompt.options ?? []).map((opt) => ({
        label: opt.label,
        selected:
          answer.length > 0 &&
          (opt.label.toLowerCase() === answer.toLowerCase() ||
            values.includes(opt.label.toLowerCase())),
      }));
      const matched = options.some((opt) => opt.selected);
      return {
        key: `${tc.id}:${prompt.id ?? index}`,
        header: prompt.header ?? null,
        question: prompt.question,
        options,
        freeAnswer: answer && !matched ? answer : null,
        unrecorded: answer.length === 0,
      };
    });
  });
}
