# Devia Method — audit of the starting skills library, v7.0.1 (S-39 / T-419)

Status: implemented (design record)
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

Source: `vendor/upstream/skills/**` (14 skills, ~10,800 lines with references). Criterion: pure discipline stays; whatever assumes files, a harness or git is adapted or replaced; whatever overlaps a Devia surface is linked to it.

## Structural finding

`executing-plans` and `subagent-driven-development` are a **state machine over files**:

```
docs/plans/<plan>.md ──task-brief──▶ <workspace>/<plan>/task-N-brief.md
        │                                  <workspace>/<plan>/progress.md   (ledger: "Task N: complete …", "Ruling: …")
        └──sdd-workspace──▶ one directory per plan   task-start / task-done / review-package
```

It exists to survive context compaction ("controllers that lost their place re-dispatched entire completed task sequences — the single most expensive failure observed"). Devia already has the native equivalent: the kanban.

| Upstream | Devia |
| --- | --- |
| plan in a `docs/` file | kanban tasks (`kanban_create_task`, `dependsOn`) |
| design doc in a `docs/` file | kanban spec (`kanban_create_spec`) |
| plan header (Goal, Architecture, Global Constraints, Review Focus) | a `Plan header: …` task |
| `task-brief PLAN_FILE N` | `kanban_get_task` (the task body IS the brief) |
| ledger `progress.md`, `Ruling:`, `minor (deferred)` | the task's comment thread (`kanban_comment`) |
| `task-start` (brief + BASE) | `kanban_move_task in_progress` + `git rev-parse HEAD` |
| `task-done` (runs tests, records only on pass) | script `task-verify` (runs tests, stores output, records nothing) + `kanban_close_task(commit)` only on exit 0 |
| "Task N: complete", resume after compaction | `kanban_close_task` with commit; `kanban_list` + `git log` |
| `sdd-workspace` (directory per plan) | removed (state no longer lives in files) |
| `review-package PLAN_FILE BASE HEAD` | `review-package BASE HEAD` (no plan; output in `.devia/review/`, self-ignored) |
| dispatched subagents | `kanban_record_subagent` logs them on the task |
| `TodoWrite` | `devia_todo` (stepper) |
| `AskUserQuestion` / asking | `devia_ask_user` (card); plain text for open conversation |
| ask for plan approval | `devia_plan_approve` |
| human review | `devia_request_review` (Changes view with anchored comments) |
| worktrees | Devia split panes (one worktree per pane, own protocol) |
| notes/decisions | Devia memory (`mem_save`, `mem_context`) |

Added advantage: with state on the kanban, **another agent can continue** (cross-agent handoff), which files in a hidden directory inside a worktree did not allow.

## Disposition matrix

| Skill | Disposition | What changes |
| --- | --- | --- |
| upstream bootstrap skill | **REPLACE** → `using-devia` | Keeps the rule ("1% chance") and red flags. Out: *Platform Adaptation* (6 `references/*-tools.md`); `SUBAGENT-STOP` stays. In: skill index (name + trigger) for agents without native discovery, and a map of Devia surfaces. |
| `brainstorming` | **ADAPT deeply** | Stays: *What do you actually know*, one question per message, *Play it back*, *Lay out the approaches*, *Size the work*, HARD-GATE, red flags, builder check. Changes: *Look Before You Ask* + recall (`mem_search`, `kanban_list_specs`); *The Written Design* → kanban spec (no `docs/` file, no commit); approval by card; decisions → `mem_save`; *Spike* → split pane. Out: *Visual Companion* and `scripts/` + `visual-companion.md`. |
| `writing-plans` | **ADAPT** | *Save plans to* → kanban tasks; header → plan header task; *Task Structure* → each task body; *Self-Review*, *Step Granularity*, *Task Right-Sizing* stay; *Execution Handoff* → `devia_plan_approve`. |
| `executing-plans` | **REWRITE** on kanban | Stays: continuous execution, *Rulings, not stalls* and the 4 stops, TDD gate per task, completion contract, final review, rationalizations. Out: workspace, ledger, `task-start`, `task-done`, plan file. |
| `subagent-driven-development` | **REWRITE** on kanban | Same + `kanban_record_subagent`. Stays: `implementer-prompt`, `task-reviewer-prompt`, `re-review-prompt`, `references/{fix-loop,final-review,handling-reports,cannot-verify,batching,preflight}`; `resuming.md` disappears (resuming = `kanban_list`). `PLAN_FILE` → task id; *Model Selection* made abstract. |
| `dispatching-parallel-agents` | **KEEP + note** | Add Devia panes (up to 4, own worktree) as real parallelism. |
| `requesting-code-review` | **ADAPT** | Keeps criterion and `code-reviewer.md` template. Adds `devia_request_review` (human review). SHAs no longer come from `docs/` paths. |
| `receiving-code-review` | **KEEP** | Only "your human partner" → "the user", and a mention of `revisa:` comments with anchors. |
| `using-git-worktrees` | **REPLACE** → `isolating-work` | Isolation is the split pane, or (S-60) a `feat/`/`fix/` branch the agent creates from `dev`/`develop`/`main`/`master` when it works alone. Keeps detection (am I already in a worktree?). Out: manual worktree creation, `.worktrees/`, gitignore. |
| `finishing-a-development-branch` | **REPLACE** → `finishing-work` | Verify → commit → `devia_request_review` → `devia_pick` (leave ready / push / PR). Close tasks with commit; suggest archiving the spec. **Out:** local merge, `git branch -D`, `git worktree remove` (its Step 6 deletes everything under `worktrees/`, which is where Devia keeps its session worktrees: `<deviaDir>/worktrees/`). |
| `test-driven-development` (+`writing-good-tests`) | **KEEP** | Only "your human partner" → "the user", cross-references without namespace prefix. |
| `systematic-debugging` (+4 refs, `find-polluter.sh`, `condition-based-waiting-example.ts`) | **KEEP + 1 line** | When closing a bug with root cause → `mem_save` type `bugfix`. |
| `verification-before-completion` | **KEEP + 1 line** | Evidence goes to the task's closing comment and `devia_todo`. |
| `writing-skills` (+refs, `render-graphs.js`) | **ADAPT (low priority)** | Where skills live in Devia (Skills manager, `.agents/skills`); drop Claude-plugin specifics and `anthropic-best-practices.md` (1,150 lines) if it adds nothing. |
| upstream diagnosis skill | **OUT** | Reads other CLIs' transcripts and can open issues. Own replacement in backlog (T-429). |

## Scripts

| Script | Destination |
| --- | --- |
| `review-package` | **ADAPT**: `BASE HEAD [OUT]`, no plan; output in `.devia/review/` with its own `.gitignore` (`*`) |
| `task-done` | **ADAPT** → `task-verify`: runs the command, stores full output, prints the tail, exits with the command's code; no longer writes a ledger |
| `task-brief`, `task-start`, `sdd-workspace` | **OUT** |
| `find-polluter.sh` | **KEEP** |
| `brainstorming/scripts/*`, `render-graphs.js` | **OUT** |

## What upstream lacks and Devia adds

Persistent memory across sessions (recall at start, decisions and bugs at close), a board visible to the user, agent-to-agent handoff, isolated parallel panes, decision cards, a review view with per-line comments, a progress stepper, plan approval with a step to apply. The method uses them in every phase instead of reinventing them with files.

## Specific risks identified

1. `executing-plans` says do not stop between tasks; Devia in apply mode with permissions can launch large changes without pauses: the 4 stop conditions (destructive, security, effect outside the worktree, broken plan) are kept and linked to `devia_confirm`.
2. SDD's *Model Selection* assumes the controller picks a model per subagent; in Devia the user fixes the model per agent: it is abstracted ("the most capable option available") and an explicit `model:` is no longer required.
3. Long imperative skill descriptions (`brainstorming`: "You MUST…") cost context every Claude turn (all descriptions live in the prompt): rewritten as short triggers.
4. The upstream bootstrap forces invoking skills *before any answer, even clarifying questions*: kept, with the explicit exception for a trivial, fully specified request (the exception brainstorming already cites).

## Related

- [01-design.md](01-design.md), [02-agents.md](02-agents.md), [../features/starter-kits.md](../features/starter-kits.md)
