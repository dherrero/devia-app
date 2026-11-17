import { describe, it, expect } from 'vitest';
import { isAskUserTool, normalizeAskUserQuestionInput, resolveAskUserQuestionAnswers } from './question-ask';
import type { QuestionPrompt } from '../contracts/events';

const PET: QuestionPrompt = {
  id: 'q1',
  header: 'Mascota',
  question: '¿Prefieres perros o gatos?',
  options: [{ label: 'Perros' }, { label: 'Gatos' }],
};

const COLOR: QuestionPrompt = {
  id: 'q2',
  header: 'Color',
  question: '¿Qué color?',
  options: [{ label: 'Rojo' }, { label: 'Azul' }],
};

// S-24: the `devia_ask_user` input schema was defined to match what this
// normaliser already accepted, so the renderer needed no changes. This pins
// that contract — if the tool schema drifts, the question card breaks silently.
describe('normalizeAskUserQuestionInput — devia_ask_user payload', () => {
  it('maps the tool input verbatim, including header, multiSelect and descriptions', () => {
    const normalized = normalizeAskUserQuestionInput({
      questions: [
        {
          id: 'q-scope',
          header: 'Alcance',
          question: '¿Servidor nuevo o dentro de kanban?',
          multiSelect: true,
          options: [
            { label: 'Servidor nuevo', description: 'Más limpio' },
            { label: 'Dentro de kanban' },
          ],
        },
      ],
    });

    expect(normalized.question).toBe('¿Servidor nuevo o dentro de kanban?');
    expect(normalized.questions).toEqual([
      {
        id: 'q-scope',
        header: 'Alcance',
        question: '¿Servidor nuevo o dentro de kanban?',
        multiSelect: true,
        options: [
          { label: 'Servidor nuevo', description: 'Más limpio' },
          { label: 'Dentro de kanban' },
        ],
      },
    ]);
  });

  it('keeps every question of a multi-question call and surfaces the first', () => {
    const normalized = normalizeAskUserQuestionInput({
      questions: [
        { question: '¿A o B?', options: [{ label: 'A' }, { label: 'B' }] },
        { question: '¿C o D?', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    });

    expect(normalized.questions).toHaveLength(2);
    expect(normalized.question).toBe('¿A o B?');
    expect(normalized.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
  });
});

// Some models send `questions` as a JSON-encoded STRING instead of an array.
// Without tolerating it the card showed the raw JSON as the question text and
// drew no option buttons.
describe('normalizeAskUserQuestionInput — questions sent as a JSON string', () => {
  const payload = [{ question: '¿Qué camino?', options: [{ label: 'A', description: 'uno' }, { label: 'B' }] }];

  it('parses a stringified array of questions', () => {
    const normalized = normalizeAskUserQuestionInput({ questions: JSON.stringify(payload) });
    expect(normalized.question).toBe('¿Qué camino?');
    expect(normalized.options).toEqual([{ label: 'A', description: 'uno' }, { label: 'B' }]);
    expect(normalized.questions).toHaveLength(1);
  });

  it('parses a stringified single question object', () => {
    const normalized = normalizeAskUserQuestionInput({ questions: JSON.stringify(payload[0]) });
    expect(normalized.question).toBe('¿Qué camino?');
    expect(normalized.options).toHaveLength(2);
  });

  it('parses a doubly-stringified array', () => {
    const normalized = normalizeAskUserQuestionInput({ questions: JSON.stringify(JSON.stringify(payload)) });
    expect(normalized.question).toBe('¿Qué camino?');
  });

  it('keeps the old fallback for a string that is not JSON', () => {
    const normalized = normalizeAskUserQuestionInput({ questions: 'not json at all' });
    expect(normalized.questions).toHaveLength(1);
    expect(normalized.options).toBeUndefined();
  });

  it('keeps the old fallback for JSON that holds no question', () => {
    const normalized = normalizeAskUserQuestionInput({ questions: '[1,2,3]' });
    expect(normalized.questions).toHaveLength(1);
    expect(normalized.options).toBeUndefined();
  });
});

describe('isAskUserTool', () => {
  it('recognises every name a question tool reaches the transcript under', () => {
    for (const name of [
      'AskUserQuestion',
      'mcp__devia-ui__devia_ask_user',
      'mcp__devia-ask__devia_ask_user',
      'devia-ui_devia_ask_user',
    ]) {
      expect(isAskUserTool(name)).toBe(true);
    }
  });

  it('rejects other tools and a missing name', () => {
    expect(isAskUserTool('mcp__devia-ui__devia_todo')).toBe(false);
    expect(isAskUserTool('Bash')).toBe(false);
    expect(isAskUserTool(undefined)).toBe(false);
  });
});

describe('resolveAskUserQuestionAnswers', () => {
  it('parses Claude\'s canned "have been answered" sentence', () => {
    const result =
      'Your questions have been answered: "¿Prefieres perros o gatos?"="Perros". You can now continue with these answers in mind.';
    expect(resolveAskUserQuestionAnswers([PET], result)).toEqual({
      '¿Prefieres perros o gatos?': 'Perros',
    });
  });

  it('parses multiple Claude pairs', () => {
    const result =
      'Your questions have been answered: "¿Prefieres perros o gatos?"="Perros", "¿Qué color?"="Azul". You can now continue.';
    expect(resolveAskUserQuestionAnswers([PET, COLOR], result)).toEqual({
      '¿Prefieres perros o gatos?': 'Perros',
      '¿Qué color?': 'Azul',
    });
  });

  it('treats a raw single-question result as the answer', () => {
    expect(resolveAskUserQuestionAnswers([PET], 'Gatos')).toEqual({
      '¿Prefieres perros o gatos?': 'Gatos',
    });
  });

  it('strips the "<header>: " prefix from a single-question answer', () => {
    expect(resolveAskUserQuestionAnswers([PET], 'Mascota: Gatos')).toEqual({
      '¿Prefieres perros o gatos?': 'Gatos',
    });
  });

  it('maps "<header>: <value>" lines on multi-question raw results', () => {
    const result = 'Mascota: Perros\nColor: Rojo';
    expect(resolveAskUserQuestionAnswers([PET, COLOR], result)).toEqual({
      '¿Prefieres perros o gatos?': 'Perros',
      '¿Qué color?': 'Rojo',
    });
  });

  it('falls back to assigning an unlabelled multi-question answer to the first prompt', () => {
    expect(resolveAskUserQuestionAnswers([PET, COLOR], 'Perros')).toEqual({
      '¿Prefieres perros o gatos?': 'Perros',
    });
  });

  // Payload + result recorded from a real pi run (agents/pi/__fixtures__/apply.jsonl):
  // the driver hands over the MCP result's text block, i.e. the raw answer.
  it('resolves a devia_ask_user result as streamed by pi', () => {
    const { questions } = normalizeAskUserQuestionInput({
      questions: [{
        header: 'Fruta favorita',
        question: '¿Cuál es tu fruta favorita?',
        options: [{ label: 'Verde', description: 'manzana' }, { label: 'Roja', description: 'fresa' }],
      }],
    });
    expect(resolveAskUserQuestionAnswers(questions, 'Verde')).toEqual({
      '¿Cuál es tu fruta favorita?': 'Verde',
    });
  });

  it('returns {} for an empty result or no questions', () => {
    expect(resolveAskUserQuestionAnswers([PET], '   ')).toEqual({});
    expect(resolveAskUserQuestionAnswers([], 'Perros')).toEqual({});
  });
});
