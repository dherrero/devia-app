import type { QuestionOption, QuestionPrompt } from '../contracts/events';

export interface NormalizedAskUserQuestion {
  question: string;
  options?: QuestionOption[];
  questions: QuestionPrompt[];
}

/**
 * Every name a question tool reaches the transcript under. The transcript must
 * render all of them as the answered-question record: since S-24 the agent asks
 * through Devia's MCP tool, and matching only `AskUserQuestion` left every
 * answer buried as a generic tool card. OpenCode prefixes MCP tools as
 * `<server>_<tool>`; the S-24 `devia-ask` server survives in old sessions.
 */
const ASK_USER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'mcp__devia-ui__devia_ask_user',
  'mcp__devia-ask__devia_ask_user',
  'devia-ui_devia_ask_user',
]);

export function isAskUserTool(name: string | undefined): boolean {
  return name !== undefined && ASK_USER_TOOL_NAMES.has(name);
}

export function normalizeAskUserQuestionInput(input: unknown): NormalizedAskUserQuestion {
  const fallback = stringifyFallback(input);
  if (input !== null && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const nested = normalizeNestedQuestions(obj['questions']);
    if (nested.length > 0) {
      return {
        question: nested[0]?.question ?? fallback,
        ...(nested[0]?.options !== undefined && { options: nested[0].options }),
        questions: nested,
      };
    }

    const flat = normalizeQuestionObject(obj, 0);
    if (flat) {
      return {
        question: flat.question,
        ...(flat.options !== undefined && { options: flat.options }),
        questions: [flat],
      };
    }
  }

  if (typeof input === 'string' && input.trim()) {
    return { question: input, questions: [{ question: input }] };
  }

  return { question: fallback, questions: [{ question: fallback }] };
}

function normalizeNestedQuestions(value: unknown): QuestionPrompt[] {
  if (!Array.isArray(value)) return [];
  const questions: QuestionPrompt[] = [];
  value.forEach((entry, index) => {
    if (entry !== null && typeof entry === 'object') {
      const normalized = normalizeQuestionObject(entry as Record<string, unknown>, index);
      if (normalized) questions.push(normalized);
    }
  });
  return questions;
}

function normalizeQuestionObject(obj: Record<string, unknown>, index: number): QuestionPrompt | null {
  const question = readString(obj, 'question') ?? readString(obj, 'prompt') ?? readString(obj, 'text');
  if (!question) return null;

  const header = readString(obj, 'header') ?? readString(obj, 'title');
  const id = readString(obj, 'id') ?? readString(obj, 'name') ?? `q${index + 1}`;
  const options = normalizeQuestionOptions(obj['options'] ?? obj['choices']);
  const multiSelect = obj['multiSelect'] === true || obj['multiple'] === true;

  return {
    id,
    ...(header !== undefined && { header }),
    question,
    ...(options !== undefined && { options }),
    ...(multiSelect && { multiSelect }),
  };
}

function normalizeQuestionOptions(value: unknown): QuestionOption[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const options: QuestionOption[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const label = entry.trim();
      if (label) options.push({ label });
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const label = readString(obj, 'label') ?? readString(obj, 'text') ?? readString(obj, 'value');
    if (!label) continue;
    const description = readString(obj, 'description') ?? readString(obj, 'hint');
    options.push(description ? { label, description } : { label });
  }
  return options.length > 0 ? options : undefined;
}

/**
 * Resolve the per-question answers recorded in an AskUserQuestion tool result
 * so the transcript can re-render the answered question card after the fact.
 *
 * Two result shapes reach the renderer:
 *  - The raw answer the user submitted, which is what Devia's own `devia-ui`
 *    MCP server returns as the tool result (one `<header>: <values>` line per
 *    question on multi-prompt submits).
 *  - LEGACY: Claude Code used to execute `AskUserQuestion` itself and return a
 *    canned sentence — `Your questions have been answered: "<q>"="<a>"…`. That
 *    tool is gone from headless runs (S-24), so no NEW transcript contains it,
 *    but sessions already on disk do and are re-rendered when reopened. Keep
 *    the parser.
 */
export function resolveAskUserQuestionAnswers(
  questions: readonly QuestionPrompt[],
  rawResult: string,
): Record<string, string> {
  const result = rawResult.trim();
  if (!result || questions.length === 0) return {};

  const claudePairs = parseClaudeAnsweredPairs(result);
  if (claudePairs) return claudePairs;

  if (questions.length === 1) {
    const question = questions[0];
    return question ? { [question.question]: stripPromptLabel(result, question) } : {};
  }

  const answers: Record<string, string> = {};
  const questionByLabel = new Map<string, QuestionPrompt>();
  for (const question of questions) {
    questionByLabel.set(question.question.toLowerCase(), question);
    if (question.header) questionByLabel.set(question.header.toLowerCase(), question);
  }

  for (const line of result.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const label = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    const question = questionByLabel.get(label);
    if (question && value) answers[question.question] = value;
  }

  if (Object.keys(answers).length === 0) {
    const first = questions[0];
    if (first) answers[first.question] = stripPromptLabel(result, first);
  }
  return answers;
}

function parseClaudeAnsweredPairs(result: string): Record<string, string> | null {
  if (!/\bhave been answered\b/i.test(result)) return null;
  const answers: Record<string, string> = {};
  const pairRe = /"([^"]+)"="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pairRe.exec(result)) !== null) {
    const question = match[1];
    if (question !== undefined && match[2] !== undefined) answers[question] = match[2];
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

function stripPromptLabel(answer: string, question: QuestionPrompt): string {
  for (const label of [question.header, question.question]) {
    if (!label) continue;
    const prefix = `${label}:`;
    if (answer.toLowerCase().startsWith(prefix.toLowerCase())) {
      return answer.slice(prefix.length).trim();
    }
  }
  return answer;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringifyFallback(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    const json = JSON.stringify(input);
    if (typeof json === 'string') return json;
  } catch {
    // Fall through to String(input) below.
  }
  return String(input);
}
