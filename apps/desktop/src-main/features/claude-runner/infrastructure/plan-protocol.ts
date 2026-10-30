/**
 * Plan-mode run protocol.
 *
 * In `plan` mode the run is confined to analysis: file-writers (Edit / Write /
 * MultiEdit / Bash) are on the denylist, so the agent CANNOT persist a plan to
 * disk. When it designs something large it tends to reach for those tools and
 * fail. The `devia-kanban` MCP server is injected in plan mode precisely for
 * this — its `kanban_*` tools ARE available. This block tells the agent to
 * write long plans there (as new specs) instead of attempting file writes.
 *
 * Appended to the system prompt only for `plan` runs.
 */
export const PLAN_PROTOCOL = [
  '## Plan mode — persist long plans to the kanban, not to files',
  '',
  'You are in **plan mode**: writing files is disabled (Edit/Write/MultiEdit/Bash are unavailable) and any attempt to write a plan to disk will fail. The `devia-kanban` MCP server IS available.',
  '',
  '- When a plan is large enough to persist, save it as a **new spec** with `kanban_create_spec` (break it into `kanban_create_task` cards as needed) instead of trying to write a Markdown/spec file.',
  '- For short answers, just reply in the chat as usual.',
].join('\n');

/**
 * Returns the plan protocol body for plan-mode runs, else null so the caller
 * omits it from the composed system prompt.
 */
export function buildPlanProtocolHint(isPlanMode: boolean): string | null {
  return isPlanMode ? PLAN_PROTOCOL : null;
}
