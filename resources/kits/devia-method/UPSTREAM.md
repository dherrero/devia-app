# Provenance

Generated from `kit.json` by `npm run kit:build` — edit the `note` there, not this file.

Devia Method 1.0.0 started from an open-source skills library (MIT; the notice is in the repository's NOTICE file),
at its tag `v7.0.1` (`2ce8aa1`). `LICENSE` is that project's, unchanged.

- **literal** — copied from the pinned upstream; only the namespace prefix of a cross-reference is dropped.
- **derived** — starts from an upstream skill; the files listed in `kit.json` as `own` are rewritten for Devia, the rest are copied.
- **own** — written for Devia.

`npm run kit:upstream-diff -- --tag <vX>` shows what changed upstream since this fork for every derived skill.

| Skill | Origin | Upstream | What changes and why |
| --- | --- | --- | --- |
| `using-devia` | own | — | Replaces the bootstrap skill of the library Devia Method started from. Keeps the rule (load a skill if there is even a small chance it applies) and the red flags; drops the per-harness tool-mapping references; adds the skill index and the map of Devia's surfaces. Anything new is never the trivial exception. |
| `brainstorming` | derived | `skills/brainstorming` | Keeps the conversation (one question at a time, playback, approaches, sizing, hard gate). Recalls memory and existing specs before asking; the design IS a kanban spec (no docs/ file, no commit); approval by card; decisions go to memory; a spike gets its own pane. Visual companion and its server removed. |
| `writing-plans` | derived | `skills/writing-plans` | The plan is kanban tasks (dependsOn orders them); the plan header goes into the spec description and each task body keeps upstream's task structure (files, interfaces, TDD steps with Expected output). Handoff is the plan-approval card, not a file link. |
| `executing-plans` | derived | `skills/executing-plans` | Rewritten on the kanban: the task body is the brief, the task thread is the ledger (rulings, deferred minors), closing a task with its commit is the completion record, resuming is kanban_list + git log. The plan file, ledger file, workspace and task-start/task-done scripts are gone. Keeps continuous execution, rulings-not-stalls, the four stops, the completion contract and the final review. |
| `subagent-driven-development` | derived | `skills/subagent-driven-development` | Same kanban-native bookkeeping as executing-plans, plus kanban_record_subagent for every dispatch. Templates and the fix loop are kept with plan-file references replaced by task ids; the model-selection rules are stated without assuming the controller can pick a model. review-package takes a commit range only; task-verify replaces task-done (runs the tests, never records). resuming.md, sdd-workspace and task-brief are gone. |
| `dispatching-parallel-agents` | derived | `skills/dispatching-parallel-agents` | Adds Devia's split panes (up to four, each with its own worktree) as real parallelism, and states that the agent's own subagent tool is used when it has one. |
| `requesting-code-review` | derived | `skills/requesting-code-review` | Adds the human review (the review card and the Changes view with line comments) next to the reviewer subagent; requirements come from the kanban task, not a docs/ plan. The reviewer inspects other revisions with git show instead of creating a worktree. |
| `receiving-code-review` | literal | `skills/receiving-code-review` |  |
| `isolating-work` | own | `skills/using-git-worktrees` | Replaces using-git-worktrees. Devia's split panes are the isolation (a worktree and a session branch per pane, managed by Devia). Keeps the detection of an existing isolated workspace; removes manual worktree creation, .worktrees/ and gitignore handling. |
| `finishing-work` | own | `skills/finishing-a-development-branch` | Replaces finishing-a-development-branch. Verify, commit, ask for review, then let the user choose by card (leave it ready / push / pull request); close the tasks with their commit, suggest archiving the spec, write the session summary. Removes the local merge, branch deletion and worktree removal — upstream's cleanup deletes anything under worktrees/, which is where Devia keeps its session worktrees. |
| `test-driven-development` | literal | `skills/test-driven-development` |  |
| `systematic-debugging` | derived | `skills/systematic-debugging` | Unchanged discipline. Cross-references lose their namespace prefix, and a fixed bug with a root cause is saved to memory as a bugfix. |
| `verification-before-completion` | derived | `skills/verification-before-completion` | Unchanged discipline. The evidence goes into the task's closing comment and the step in the progress list. |
| `writing-skills` | derived | `skills/writing-skills` | Points at where Devia keeps skills (the Skills manager, .agents/skills and .claude/skills) instead of Claude plugin paths and per-runtime tool-mapping references. The Claude-specific best-practice dump and the CLAUDE.md testing notes are dropped. |
