---
name: executing-plans
description: "Executing the kanban plan yourself, task by task, with TDD and one final review."
---

# Executing Plans

Execute the plan yourself, task by task, in this session: no implementer subagent per task, no reviewer per task. One fresh-context review of the whole branch at the end.

**Why inline:** Subagent-driven development pays for a fresh implementer and a fresh reviewer on every task, each re-reading the codebase from zero. Inline execution pays for one context (yours) plus one reviewer at the end. What it gives up is a fresh context per task and a second pair of eyes per task. This skill keeps what those two things bought, by other means: the task body is the spec, the task's thread is your memory, TDD is the per-task gate, and the final reviewer is the second pair of eyes.

**Core principle:** The plan already did the thinking. Execute it exactly, prove each step with a test you watched fail and then pass, and leave a record that survives your own forgetting.

**Narration:** between tool calls, narrate at most one short line. The board and the tool results carry the record.

**Continuous execution:** Do not pause to check in with the user between tasks. They approved the plan to spend less of their time, not to answer "should I continue?" after every task. Execute all tasks from the plan without stopping.

**Rulings, not stalls.** Conflicts, ambiguities, plan defects: decide them. The spec is the binding authority, the plan is its argument, and your judgment settles what neither answers. Record every decision as a comment on the task: `kanban_comment` with `Ruling: <what you decided> — <why> — <what it costs if wrong>`, and keep going. Deviating from the plan without a recorded ruling is a decision made in secret.

Four things stop you, and only these: an irreversible or destructive operation (ask with `devia_confirm`); a security-sensitive action; a side effect outside this pane that norms say you ask about first (a merge, a push to a shared branch, a publish); and a plan so broken that every path forward is a guess. For those, stop and ask (`kanban_request_user_input` blocks the task with your question).

## When to Use

- You have a plan from `writing-plans` (tasks on the kanban) and the user approved it, with inline execution or with no choice made.
- You have no subagent tool. Never fabricate a dispatch; run the plan here.
- Tasks are mostly independent: the same precondition as `subagent-driven-development`.

A fully specified plan makes inline execution transcription plus testing: it runs well on a mid-tier model, and the one place the most capable model earns its cost is the final review, which this skill dispatches separately.

Prefer `subagent-driven-development` when the user wants a review gate on every task, or when the plan is long enough that its later tasks would run on a compacted context. Inline execution over a long plan still works, because the board is what makes it recoverable, but the last tasks get the least of you.

## The Process

1. **Setup:** isolated pane, plan header and spec read, one progress item per task, pre-flight scan.
2. **Per task:** take it, work its steps under TDD, compare every `Expected:`, commit, meet the completion contract, verify and close it.
3. **When none remain:** final whole-branch review, one fix pass for what it found, then `finishing-work`.

## Setup

Make sure the work happens in an isolated workspace: `isolating-work` says how to check. Never start implementation on the main branch without the user's explicit consent.

Conversation memory does not survive compaction. An executor that loses its place re-implements tasks whose commits already exist. The board is the record, and your own recollection is not:

- Find the plan: `kanban_list_specs`, then `kanban_list` for that spec. Tasks in `done` are complete (their commits exist in git), the one in `in_progress` is where you were, the rest are `todo`.
- **Resuming** (after compaction, in a new session, or as a different agent): do not redo `done` tasks. Read the thread of the `in_progress` task with `kanban_get_task` and continue from the last step it records. Trust the board and `git log` over your recollection.
- Read the plan header task once: its Global Constraints bind every task, and its Review Focus goes to the final reviewer. Read the spec too: it is the authority the plan argues from, and conflicts inside the plan resolve against it.
- Publish one `devia_todo` item per task; the list is the live view, the board is the record.

**Load `test-driven-development` now**, before Task 1. It governs every step of every task below; a plan whose steps already say "write the failing test first" does not exempt you from reading it.

Before Task 1, scan the plan for conflicts between tasks. The Interfaces blocks tell you where to look: for every task that consumes what an earlier task produces, note the two tasks, what one produces against what the other consumes, and what you found. Tasks that share nothing get no row; a plan whose tasks share nothing gets the single line `Pre-flight: no shared interfaces`. Rule on each conflict a row surfaces with the spec as the binding authority, and record the table and the rulings as one comment on the plan header task. Each task's own text is checked when you read it, not here.

## The Task Loop

Everything you print, and every tool result, stays resident in your context for the rest of the session. Redirect long test output to a file and read its tail (`task-verify` does this).

### 1. Take the task

- `kanban_get_task` for the task: that body is the brief, with the exact values, signatures and test cases. Read it for every task, including ones you remember from setup: what you remember is a summary.
- `kanban_move_task` to `in_progress`, mark its `devia_todo` item in progress, and note BASE (`git rev-parse HEAD`): the commit the task's review range is cut from.

Every tool call is a turn that re-reads your whole context. Bookkeeping rides along with work: a comment in the same turn as the commit, never a turn of its own.

### 2. Work the steps

The plan's steps are already in RED-GREEN order; follow them in that order under `test-driven-development`. A test step's code is written first and run first. Watching it fail is a step, not a formality: a test that passes before the implementation exists is a finding about the test.

Every step that runs a command has an `Expected:` line. Run the command, read its output, and compare. Three outcomes:

- **Matches.** Next step.
- **The code is wrong.** Load `systematic-debugging`. Find the cause; never patch the symptom to make the step's output match.
- **The plan is wrong:** a step contradicts the spec, an interface from an earlier task doesn't match what this task consumes, a command that cannot work. Rule on the smallest change that satisfies the spec, record it as `Ruling: <finding> — <what you decided and why>` in the task's thread, and continue. Later tasks that touch the same interface read it there.

Commit as the plan's commit steps say. A task that spans several commits is fine; BASE is what the review range is cut from, never `HEAD~1`.

### 3. The completion contract

Before you close a task, all of the following are true, with evidence from this session, not inferred from the diff looking right:

- Every test the brief names exists and ran in this task, and you read the output.
- The final test run for the task passed.
- Every `Expected:` line in the brief was compared against real output.
- Every deviation from the brief has a `Ruling:` comment.

**Load `verification-before-completion`:** it governs the claim. If any item is missing, the task is not complete: finish it.

### 4. Complete the task

Run the task's whole-task test command through `task-verify` (a script of the `subagent-driven-development` skill; `devia_skill` prints that skill's directory when you load it): `bash <directory>/scripts/task-verify -- <test command>`. It runs the tests, keeps the full output in a git-ignored file, prints the tail, and exits with the command's status.

Only if it exited 0: `kanban_close_task` with the closing commit and, in the same turn, a `kanban_comment` with the evidence (`commits <base7>..<head7>, tests: <command> → <result>`), and mark the `devia_todo` item done. A failing run closes nothing: the task is not complete.

## Final Review

Run `bash <directory>/scripts/review-package MERGE_BASE HEAD` (MERGE_BASE = the commit the branch started from, e.g. `git merge-base main HEAD`) and review from the file it prints.

**With a subagent tool:** dispatch the reviewer on the most capable model available. The whole-branch review is a judgment task. Use `code-reviewer.md` from `requesting-code-review`, with the package path, the spec's id and the plan header task's id, the plan's Review Focus section verbatim (the input classes and failure modes the plan's tests do not exercise, which the reviewer checks deliberately), and a pointer to the `Ruling:` comments so it can weigh the calls you made. Choose the model on purpose: an omitted model may inherit one that is not the most capable. This is the one fresh context the whole run buys. Do not skip it, and do not replace it with your own read of the diff. Record the dispatch with `kanban_record_subagent` on the plan header task.

**Without a subagent tool:** read `code-reviewer.md` and perform that review yourself against the package, as a separate pass after the last task. Comment `Final review: self-review (no subagent tool)` on the plan header task, and say so in your final message: a self-review by the author is weaker than a fresh reviewer, and the user decides whether that is enough before merge.

Sort the findings before you act on any of them. The reviewer's severity labels are advice; the gate is yours. Its "Declined to judge" list is yours too: every line there is a ruling you make and record, exactly like a plan conflict: `Final: Ruling: <behavior the reviewer set aside> — <what a reasonable person using this software gets, and why that stands or why it is now a finding> — <cost if wrong>`. Re-grade first, by effect: the spec is a vision document, and a finding's grade is what a reasonable person using this software gets if it ships, not whether the spec names the input that triggers it. A reviewer who set a finding at Minor because the spec was silent has graded the spec, not the effect. Then:

- **Critical and Important** enter the fix pass.
- **Minor** goes on the plan header task as `Final: minor (deferred): <one-liner>` and to your final message under "Deferred minors". Minors never enter the fix pass, and never become rulings: a ruling is a decision about a conflict, not a note that you declined a polish suggestion.

Fix the Critical and Important findings yourself, in ONE pass. Each fix is verified by TDD, not by a second reviewer: write the test that reproduces the finding, watch it fail, make it pass, then run the whole suite. Comment each as `Final: fixed <finding> — <test name> RED→GREEN, suite <N>/<N>`. A fix without a test that failed first is not verified; a suite that is not green after the pass means the pass is not over. Do not dispatch a re-review: it would re-read a diff whose covering tests already answer "addressed" and whose suite run already answers "broke nothing".

A finding you decide not to fix is a ruling (`Final: Ruling: <finding> — <why the code stands> — <cost if wrong>`) and reaches the user in the rulings list. There is no second fix pass.

## Finish

Collect every comment containing `Ruling:` (on the tasks and on the plan header task) into your final message under "Rulings I made", in the order you made them, each with what it costs if wrong, and every `minor (deferred)` comment under "Deferred minors". Both lists are exhaustive. Your final message is the only place the decisions you took on the user's behalf, and the findings you chose not to act on, reach them.

When the final review is clean and its fixes are committed, load `finishing-work`.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I remember what Task N says" | You remember a summary. The task body has the exact values. Read it. |
| "The plan's code is right, skip watching the test fail" | A test you never saw fail proves nothing. It is one step. Run it. |
| "I'll run the full suite at the end instead of per step" | Per-step runs are how you learn which step broke it. The end-of-task run is the contract, not a substitute. |
| "The plan is wrong here, I'll just do the right thing" | Do the right thing and comment the ruling. An unrecorded deviation is a decision made in secret. |
| "I'll write the comments after a few tasks" | Compaction does not wait for a convenient moment. One comment per task, in the same turn as the commit. |
| "Let me check in before the next task" | They approved the plan to spend less of their time. Only the four stops stop you. |
| "I read my own diff carefully; the final reviewer is redundant" | Same author, same blind spots. The reviewer is the only fresh context this run buys. |
| "Tests should pass, the change was trivial" | "Should" is not evidence. The contract requires the command and its output. |
| "Subagents are slow and expensive, I'll skip the final review too" | Inline already removed the per-task reviewers. One review of the whole branch is the floor, not the ceiling. |
| "The reviewer said Minor, so it's Minor" | The label graded the spec's silence. Grade what the person gets. Re-grade, then gate. |
| "The fix is obvious, no need for a failing test first" | The failing test is the only proof the finding was real and is now gone. Without it you have a diff and a hope. |
| "I'll fix the minors too while I'm in there" | Every minor you fix is a test, a fix and a suite run the user did not ask for. Record them; the user decides. |
