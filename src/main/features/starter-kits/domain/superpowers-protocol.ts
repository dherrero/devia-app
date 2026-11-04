/**
 * Devia's side of the Superpowers integration (S-38).
 *
 * Superpowers skills name ACTIONS ("create a todo", "dispatch a subagent"),
 * never tools, and upstream expects each harness to translate them (its own
 * `references/<harness>-tools.md`). This is that translation for Devia. No
 * skill body is edited: the skills themselves allow the user's preference to
 * override where a spec or plan is saved, and that is how they reach the board.
 *
 * Kept short on purpose — it sits in the cached prompt prefix on every turn.
 */
export function buildSuperpowersProtocol(kitDir: string): string {
  return [
    '## Superpowers on Devia',
    '',
    `The Superpowers skills describe actions, not tools. On Devia they map as follows; this mapping overrides any default tool or save location a skill names. The skills live in \`${kitDir}/skills\`.`,
    '',
    '**Order of work.** When asked to build or change something, invoke `brainstorming` FIRST — before exploring, before planning, before any tool call that persists anything — and let it ask the user its questions one at a time. Devia\'s own plan-mode steps (explore, persist the plan on the kanban, ask for approval) come AFTER the design is agreed, never instead of it. A request that is fully specified and trivial is the only exception.',
    '',
    '| A skill says | On Devia |',
    '| --- | --- |',
    '| ask the user / AskUserQuestion | `devia_ask_user`; if it is not offered, ask in plain text and end your turn |',
    '| create a todo / TodoWrite | `devia_todo` (send the complete list every time) |',
    '| invoke or load a skill, `superpowers:<name>` | `devia_skill` with `{"op":"load","name":"<name>"}`; names are plain (`brainstorming`). Claude Code: its Skill tool with `superpowers:<name>` |',
    '| a file bundled with a skill (`references/…`, prompts) | `devia_skill` load with name `<skill>/<relative path>` |',
    `| a script bundled with a skill (\`bash scripts/x\`) | \`bash ${kitDir}/skills/<skill>/scripts/x\`, only where you have Bash |`,
    '| design doc (`docs/superpowers/specs/…`) | one kanban spec: `kanban_create_spec`, the design in its description; write no file |',
    '| implementation plan (`docs/superpowers/plans/…`) | one `kanban_create_task` per plan task: column `todo`, `dependsOn` for the order, the plan task text as the body |',
    '| get a design or plan approved | `devia_plan_approve` (steps = the task titles) in plan mode; `devia_ask_user` otherwise |',
    '| request a review | `devia_request_review` in apply mode |',
    '| dispatch a subagent | your own subagent tool if you have one; otherwise do the work inline and never invent a Task call |',
    '',
    '**Isolation belongs to Devia.** Never create, switch or remove a git worktree, and never delete a session branch: skip `using-git-worktrees`, and when `finishing-a-development-branch` reaches its worktree cleanup, treat the worktree as externally managed and leave it — even if its path contains `worktrees/`. Do not merge into the base branch locally. Finish by verifying the tests, committing, and telling the user what they can merge or open as a PR from Devia.',
    '',
    '**Plan mode cannot write files.** Brainstorm and plan there: once the design is approved, the design and the plan live on the kanban, and the user approving the plan is what starts the implementation.',
  ].join('\n');
}

/**
 * Bootstrap for an agent that cannot load the kit natively: upstream's
 * `using-superpowers` skill, wrapped the way its own session hook wraps it.
 * Frontmatter is stripped; the body is otherwise verbatim.
 */
export function wrapBootstrap(skillMarkdown: string): string {
  const body = skillMarkdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  return [
    '<EXTREMELY_IMPORTANT>',
    "You have superpowers. Below is your 'using-superpowers' skill, your introduction to using skills. It is already loaded: do not load it again.",
    '',
    body,
    '</EXTREMELY_IMPORTANT>',
  ].join('\n');
}
