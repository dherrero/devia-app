import { KANBAN_TOOLBOX } from '../../sdd/prepare/prompts';

/**
 * Plan-mode run protocol.
 *
 * In `plan` mode the run is confined to analysis: file-writers (Edit / Write /
 * MultiEdit / Bash) are on the denylist, so the agent CANNOT persist a plan to
 * disk. The `devia-kanban` MCP server is injected in plan mode precisely for
 * this — its `kanban_*` tools ARE available — and the board is where the plan
 * lives. This block is a mandatory contract (explore → persist to the kanban →
 * ask for approval), not a hint: left optional, agents answer in chat and the
 * plan is lost with the conversation.
 *
 * Appended to the system prompt only for `plan` runs.
 */
export const PLAN_PROTOCOL = [
  '## Plan mode — plan in detail and persist it to the kanban',
  '',
  'You are in **plan mode**: writing files is disabled (Edit/Write/MultiEdit/Bash are unavailable) and any attempt to write a plan to disk will fail. Your job is to produce a detailed, reviewable plan and store it on the project board (the `devia-kanban` MCP server), not in a file and not only in the chat.',
  '',
  '1. **Explore first, read-only.** Read the relevant code, conventions and tests before planning. Do not guess file names or APIs.',
  '2. **Persist the plan on the kanban** for any non-trivial work (anything beyond a short answer or a one-step change):',
  '   - Call `kanban_create_spec` ONCE for the goal, with the context, the approach and the decisions taken.',
  '   - Call `kanban_create_task` for each concrete step with column "todo", in execution order. Each body must be actionable on its own: the files to touch, what to change, acceptance criteria and the tests to add or update. Use `dependsOn` for ordering.',
  '   - Put speculative or future ideas in the "backlog" column, not in "todo".',
  '3. **Ask for approval.** Summarise the plan (steps referencing the kanban ids, risks) and request approval the way the tools section above describes, then wait. If the user wants to keep planning, update the spec/tasks on the board (do not create a duplicate spec) and ask again.',
  '4. **Never start implementing** in plan mode, and do not end a non-trivial planning turn without the plan being on the board.',
  '',
  'For short answers or questions that need no plan, just reply in the chat.',
  '',
  KANBAN_TOOLBOX,
].join('\n');

/**
 * Plan-mode protocol when the Devia Method (S-39) is active. The method's
 * skills own the sequence (brainstorming → an approved design recorded as ONE
 * spec → writing-plans → the plan card), so this block must not order anything
 * the other way round: two protocols giving different first steps is what made
 * a small model skip the questions and persist a plan straight away.
 */
export const METHOD_PLAN_PROTOCOL = [
  '## Plan mode — writing files is disabled',
  '',
  'You are in **plan mode**: Edit/Write/MultiEdit/Bash are unavailable, so nothing can be written to disk. Everything the method asks you to record goes on the project board (the `devia-kanban` MCP server), and nothing needs a file.',
  '',
  'Follow the method\'s sequence: `brainstorming` first (questions, then a design the user approves), then ONE `kanban_create_spec` with the approved design, then `writing-plans` (a plan header task and one task per step, in column `todo`), then ask for approval of the plan. Do not put anything on the board before the design is approved. The board cannot edit a spec: on "keep planning" change the tasks with `kanban_update_task` and never create a second spec or a second set of tasks.',
  '',
  'Never start implementing in plan mode. For a short answer or a question that needs no plan, just reply.',
  '',
  KANBAN_TOOLBOX,
].join('\n');

/**
 * Returns the plan protocol body for plan-mode runs, else null so the caller
 * omits it from the composed system prompt. With the method active it is the
 * method-aware variant.
 */
export function buildPlanProtocolHint(isPlanMode: boolean, methodActive = false): string | null {
  if (!isPlanMode) return null;
  return methodActive ? METHOD_PLAN_PROTOCOL : PLAN_PROTOCOL;
}
