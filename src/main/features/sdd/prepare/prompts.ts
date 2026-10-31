/** Minimal task shape the wake prompt needs — satisfied by both the
 *  KanbanTask domain object and the KanbanTaskView. */
export interface WakeTask {
  readonly id: string;
  readonly specId: string;
  readonly title: string;
  readonly body: string;
}

/**
 * SDD orchestration prompts (E-DSK-12 T3/T9/T6).
 *
 * These are AI-targeted instruction strings the renderer dispatches
 * to the active CLI agent through the normal `sendInstruction` path.
 * Building them in the main process keeps them pure + unit-testable;
 * dispatch stays in the renderer where chat/session state lives.
 *
 * Every prompt references the `kanban_*` MCP tools exposed by the
 * bundled devia-kanban server (T5) so the agent drives the board
 * itself.
 */

/**
 * UI-language → English language name, for the reply-language instruction.
 * Mirrors the renderer's supported i18n set; unknown codes fall back to
 * English (same behaviour as the UI).
 */
const LANGUAGE_NAMES: Record<string, string> = {
  es: 'Spanish', en: 'English', ca: 'Catalan', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', ru: 'Russian', zh: 'Chinese', hi: 'Hindi',
  ar: 'Arabic',
};

/**
 * Reply-language line appended to every SDD prompt. These prompts are
 * English (AI-targeted), which without this line drags the agent into
 * replying in English even when the user writes in Spanish. Scope is the
 * CHAT only — code, file contents, AGENTS.md and board entries keep their
 * own conventions.
 */
export function buildLanguageLine(langCode?: string): string {
  const name = LANGUAGE_NAMES[(langCode ?? 'en').slice(0, 2).toLowerCase()] ?? 'English';
  return `Write every conversational reply to the user in ${name} (this prompt being English does not change that). Code, file contents and AGENTS.md keep their own conventions.`;
}

/** Shared reminder of the kanban tool contract appended to every prompt. */
export const KANBAN_TOOLBOX = [
  'You have access to the devia-kanban MCP tools to drive the project board:',
  '- kanban_create_spec(title, description) → returns a spec id (S-n).',
  '- kanban_create_task(specId, title, body, dependsOn?, column?) → returns a task id (T-n). column "todo" puts it straight into the active plan; "backlog" (default) is for later/uncertain ideas. Use dependsOn for tasks that must run after others.',
  '- kanban_list() → current board snapshot (specs + tasks + columns).',
  '- kanban_get_task(taskId) → full task detail incl. thread.',
  '- kanban_move_task(taskId, column) → backlog | todo | in_progress | done.',
  '- kanban_comment(taskId, body) → post progress to the task thread (the user sees it live).',
  '- kanban_request_user_input(taskId, question) → block the task and ask the user; resume when they reply.',
  '- kanban_record_subagent(taskId, subagentName, summary) → log a delegated sub-agent run.',
  '- kanban_close_task(taskId, commit?) → move the task to done, optionally linking the closing commit.',
].join('\n');

/**
 * T3 / SDD-F2 — plan new work on an EXISTING project.
 *
 * This is PLAN mode, not analysis mode: the agent does NOT run a full
 * codebase audit and does NOT scaffold guidance files. It talks to the
 * user, then turns the agreed goal into a set of ready-to-work tasks.
 * The user's free-text intent is appended by the caller.
 */
export function buildPreparePrompt(projectName: string, language?: string): string {
  return [
    `You are Devia's project planner for the EXISTING project "${projectName}".`,
    '',
    buildLanguageLine(language),
    '',
    'Work in PLAN mode: do NOT modify product/source code and do NOT run a full codebase analysis.',
    '',
    '1. Skim AGENTS.md / README only if present, for light context. Otherwise rely on what the user tells you.',
    '2. Talk to the user FIRST. Ask focused clarifying questions about the goal, scope and constraints until you genuinely understand what they want. Do NOT create any tasks until then.',
    '3. When the goal is clear, capture it and break it down:',
    '   - Call kanban_create_spec once for the theme/goal.',
    '   - Call kanban_create_task for each concrete step with column "todo" (ready to work), clear titles and short actionable bodies. Use dependsOn for ordering.',
    '   - Put only speculative / future / undecided ideas in the backlog (column "backlog").',
    '4. Present the plan back as a short summary and ask the user to review it. Do NOT start working yet.',
    '5. Only after the user approves (e.g. "empieza" / "ponte con ello"), start the first task that has no unmet dependencies by moving it to in_progress, and work the tasks sequentially.',
    '',
    KANBAN_TOOLBOX,
  ].join('\n');
}

/**
 * T9 / SDD-F2 — initialise a NEW project from a user-described intent.
 * A spec was already created by the main process; the agent plans it
 * into ready-to-work tasks after confirming scope with the user.
 */
export function buildInitPrompt(opts: {
  projectName: string;
  specId: string;
  specTitle: string;
  intent: string;
  language?: string;
}): string {
  return [
    `You are Devia's project planner initialising the NEW project "${opts.projectName}".`,
    '',
    buildLanguageLine(opts.language),
    '',
    'The user described the goal:',
    '"""',
    opts.intent.trim(),
    '"""',
    '',
    `A spec ${opts.specId} ("${opts.specTitle}") has already been created for you on the board.`,
    '',
    'Work in PLAN mode — do NOT implement the tasks yet, and do NOT create or modify ANY files (the sandbox is read-only; file work belongs to the tasks).',
    '',
    '1. If the goal is ambiguous, ask the user focused clarifying questions first (stack, scope, constraints). Only proceed once it is clear.',
    `2. Break the goal into an ordered set of tasks against spec ${opts.specId}: call kanban_create_task with column "todo" for each step ready to work; use dependsOn for ordering. Put only speculative / future ideas in the backlog (column "backlog").`,
    '3. The FIRST task must include creating AGENTS.md at the repository root with the intended stack, conventions and commands (English). AGENTS.md is the standard; if a CLAUDE.md (or another agent file) is added, it must only point to AGENTS.md, not duplicate it.',
    '4. Present the plan back as a short summary and ask the user to review it. Do NOT start working yet.',
    '5. Only after the user approves, start the first task that has no unmet dependencies by moving it to in_progress, and work the tasks sequentially.',
    '',
    KANBAN_TOOLBOX,
  ].join('\n');
}

export type WakeReason = 'started' | 'user_reply' | 'dependency_resolved';

/**
 * T6 — wake prompt dispatched when a task (re)enters in_progress. The
 * agent works the task and drives its lifecycle through the kanban
 * tools. The commit footer convention (T10) is restated so closing
 * commits are traceable.
 */
export function buildWakePrompt(task: WakeTask, reason: WakeReason, language?: string): string {
  const footer = `Spec: ${task.specId}-${task.id}`;
  const head =
    reason === 'user_reply'
      ? `The user just replied on kanban task ${task.id} ("${task.title}"). Read the latest thread with kanban_get_task and continue from there.`
      : reason === 'dependency_resolved'
        ? `A dependency for kanban task ${task.id} ("${task.title}") is now done. Resume work on it.`
        : `Work on kanban task ${task.id} ("${task.title}").`;

  return [
    head,
    '',
    buildLanguageLine(language),
    '',
    task.body ? `Task description:\n${task.body}` : '',
    '',
    'Workflow:',
    '- Post meaningful progress to the task thread with kanban_comment so the user follows along.',
    '- If you need a decision or are missing information, call kanban_request_user_input(taskId, question) and stop — the task blocks until the user replies.',
    '- If you delegate to a sub-agent, log it with kanban_record_subagent.',
    `- When the work is complete, commit with a trailer line "${footer}" and call kanban_close_task("${task.id}", "<commit-sha>").`,
    '',
    KANBAN_TOOLBOX,
  ]
    .filter((l) => l !== '')
    .join('\n');
}
