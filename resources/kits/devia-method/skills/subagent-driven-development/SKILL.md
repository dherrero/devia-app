---
name: subagent-driven-development
description: "Executing the kanban plan with a fresh subagent per task and a review after each."
---

# Subagent-Driven Development

Execute the plan by dispatching a fresh implementer subagent per task, a task review (spec compliance + code quality) after each, and a broad whole-branch review at the end.

**Why subagents:** You delegate tasks to specialized agents with isolated context. By precisely crafting their instructions and context, you ensure they stay focused and succeed at their task. They should never inherit your session's context or history: you construct exactly what they need. This also preserves your own context for coordination work.

**Core principle:** Fresh subagent per task + task review (spec + quality) + broad final review = high quality, fast iteration.

**Needs a subagent tool.** If your agent has none, never fabricate a dispatch: run the plan with `executing-plans`.

**Narration:** between tool calls, narrate at most one short line. The board and the tool results carry the record.

**Continuous execution:** Do not pause to check in with the user between tasks. Execute all tasks from the plan without stopping. The only reasons to stop are the four named below, or all tasks complete. "Should I continue?" prompts and progress summaries waste their time: they approved the plan, so execute it.

**Rulings, not stalls.** A running plan does not wait on a human. Conflicts, ambiguities, plan defects, a cap you would have asked to exceed: decide them. The spec is the binding authority, the plan is its argument, and your judgment settles what neither answers. Record every decision as a comment on the task (`kanban_comment`): `Ruling: <what you decided> — <why> — <what it costs if wrong>`, and keep going. A wrong ruling costs rework the user can see and undo; a session parked on a question costs their whole day and buys nothing.

Four things stop you, and only these: an irreversible or destructive operation (ask with `devia_confirm`); a security-sensitive action; a side effect outside this pane that norms say you ask about first (a merge, a push to a shared branch, a publish); and a plan so broken that every path forward is a guess. For those, stop and ask (`kanban_request_user_input` blocks the task with your question).

## When to Use

- You have a plan (tasks on the kanban, approved) with mostly independent tasks, and a subagent tool: use this skill.
- The user chose inline execution, or you have no subagent tool: `executing-plans`.
- No plan yet, or tightly coupled tasks: brainstorm or plan first.

**Versus inline:** a fresh subagent per task (no context pollution) and a review after each task, instead of one context doing every task and one review at the end. It costs a fresh context per task and per review. Both run in this session, share the same board, and never pause between tasks.

## Setup

Make sure the work happens in an isolated workspace: `isolating-work` says how to check. Never start implementation on the main branch without the user's explicit consent.

Conversation memory does not survive compaction. Controllers that lost their place have re-dispatched entire completed task sequences: the single most expensive failure observed. The board is your recovery map:

- Find the plan: `kanban_list_specs`, then `kanban_list` for that spec. `done` tasks are complete (their commits exist in git), the one `in_progress` is where you were, the rest are `todo`.
- **Resuming** (after compaction, in a new session, or as a different agent): never re-dispatch a `done` task. Read the thread of the `in_progress` task with `kanban_get_task`: a task whose last comment is a fix round is mid-loop, so resume the loop at the next round. Trust the board and `git log` over your recollection.
- Read the plan header task once: its Global Constraints bind every task, and its Review Focus goes to the final reviewer. Read the spec too: it is the authority the plan argues from, and conflicts inside the plan resolve against it.
- Publish one `devia_todo` item per task.

Before dispatching Task 1, read `references/preflight.md` and run the conflict scan it describes. Its table and rulings go on the plan header task as one comment.

## Model Selection

Use the least powerful model that can handle each role, **when your subagent tool lets you choose one**; if it does not, the subagent runs on your model and the rules below tell you how much to trust it.

**Mechanical implementation tasks** (isolated functions, clear specs, 1-2 files): a fast, cheap model. Most implementation tasks are mechanical when the plan is well specified.

**Integration and judgment tasks** (multi-file coordination, pattern matching, debugging): a standard model.

**Architecture and design tasks**: the most capable model available. The final whole-branch review is one of these.

**Review tasks**: choose with the same judgment, scaled to the diff's size, complexity and risk. A small mechanical diff does not need the most capable model; a subtle concurrency change does. Scoped re-reviews of small fix diffs take a cheap-to-mid tier.

**Fix-loop escalation (rounds 4-5)**: a model at least one tier above the implementer that got stuck.

**Turn count beats token price.** Wall-clock and context cost scale with how many turns a subagent takes, and the cheapest models routinely take 2-3× the turns on multi-step work, costing more overall. Use a mid-tier model as the floor for reviewers and for implementers working from prose descriptions. When the task's text contains the complete code to write, the implementation is transcription plus testing: use the cheapest tier. Single-file mechanical fixes also take the cheapest tier.

## The Task Loop

**Small same-shape work:** when the plan lists several small edits of the same kind across files, read `references/batching.md` before dispatching them.

Everything you paste into a dispatch prompt, and everything a subagent prints back, stays resident in your context for the rest of the session and is re-read on every later turn. Hand artifacts over by reference: a task id, a file path.

### 1. Dispatch the implementer

Record BASE (`git rev-parse HEAD`) before dispatching: the review package and fix-round diffs need it. `kanban_move_task` the task to `in_progress` and mark its `devia_todo` item.

- **The brief is the task.** The implementer reads it itself with `kanban_get_task` for the task's id: the body has the exact values, signatures and test cases. Your dispatch contains: (1) one line on where this task fits in the project; (2) the task id, introduced as "read this first: it is your requirements, with the exact values to use verbatim"; (3) interfaces and decisions from earlier tasks that the task cannot know; (4) your resolution of any ambiguity you noticed in it; (5) the report-file path and report contract. Exact values appear only in the task. Never make a subagent read the whole plan.
- **Report file:** name it after the task (`.devia/review/task-<id>-report.md`) and put it in the dispatch prompt. The implementer writes the full report there and returns only status, commits, a one-line test summary, and concerns.
- A dispatch prompt describes one task, not the session's history. Do not paste accumulated summaries of earlier tasks into later dispatches. A fresh subagent needs its task, the interfaces it touches, and the global constraints. Nothing else.
- The dispatch carries the no-subagents contract (it is in the implementer template): the implementer never dispatches subagents, not helpers, and never a reviewer. Review arrives from you, after the report. Every reviewer a worker spawned duplicated the task review the controller dispatched anyway.
- If an earlier task parked a finding in the area this task touches, point to its comment in the dispatch.
- Log the dispatch with `kanban_record_subagent` (task id, the subagent's name, one-line summary), and remember the agent's identity from the dispatch result: fix-loop rounds 1-3 resume this agent.
- Never dispatch multiple implementation subagents in parallel in the same checkout (conflicts). For real parallelism use separate panes (`dispatching-parallel-agents`).

Template: `implementer-prompt.md`

### 2. Handle the report

Implementer subagents report one of four statuses.

**DONE:** generate the review package (`bash scripts/review-package BASE HEAD`, from this skill's directory; it prints the unique file path it wrote; BASE is the commit you recorded before dispatching the implementer, never `HEAD~1`, which silently drops all but the last commit of a multi-commit task), then dispatch the task reviewer with the printed path.

**Any other status** (DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED): read `references/handling-reports.md` and follow it, every time you get one.

If the implementer asks questions, before starting or mid-task, answer clearly and completely, provide additional context if needed, and don't rush it into implementation.

### 3. Review the task

Per-task reviews are task-scoped gates. The broad review happens once, at the final whole-branch review. Never skip the task review, and never accept a report missing either verdict: spec compliance AND task quality are both required. The implementer's self-review never replaces the task review; both are needed.

- Hand the reviewer its diff as a file: `bash scripts/review-package BASE HEAD` (or, without bash: `git log --oneline`, `git diff --stat` and `git diff -U10` for the range, redirected to one uniquely named file). The output never enters your own context, and the reviewer sees the commit list, stat summary and full diff with context in one Read call. Use the BASE you recorded before dispatching the implementer. Never dispatch a task reviewer without a diff file.
- **Reviewer inputs:** the task id (its brief), the report file, and the review package, plus the global constraints that bind the task.
- The global-constraints block you hand the reviewer is its attention lens. Copy the binding requirements verbatim from the plan header task or the spec: exact values, exact formats, and the stated relationships between components. The reviewer's template already carries the process rules (YAGNI, test hygiene, review method); the constraints block is for what THIS project's spec demands.
- Do not add open-ended directives like "check all uses" or "run race tests if useful" without a concrete, task-specific reason.
- Do not ask a reviewer to re-run tests the implementer already ran on the same code: the implementer's report carries the test evidence.
- Do not pre-judge findings for the reviewer: never instruct a reviewer to ignore or not flag a specific issue. If you believe a finding would be a false positive, let the reviewer raise it and adjudicate it in the review loop. If the prompt you are writing contains "do not flag," "don't treat X as a defect," "at most Minor," or "the plan chose": stop. You are pre-judging, usually to spare yourself a review loop.

If the reviewer reports "⚠️ Cannot verify from diff" items, read `references/cannot-verify.md` before you close the task.

Template: `task-reviewer-prompt.md`

### 4. The fix loop

The loop triggers when the review reports spec ❌, any Critical or Important finding, or a ⚠️ item you confirmed as a real gap.

When it triggers, read `references/fix-loop.md` and follow it. Read it again before every round, even if you read it earlier in this session: it holds the round cap, the breaker and the comment each round writes, and your memory of it does not survive compaction.

### 5. Complete the task

When the review comes back clean, or every open finding is parked with a ruling at the cap, run the tests for the task once more through `bash scripts/task-verify -- <test command>` and, only if it exits 0, close the task: `kanban_close_task` with the closing commit and, in the same turn, a comment with the evidence:

- `Complete (commits <base7>..<head7>, review clean)`
- `Complete (commits <base7>..<head7>, <K> parked)` after a tripped breaker

Then mark the `devia_todo` item done and move on. Never move to the next task while the review has open Critical/Important issues that are neither fixed nor parked-with-ruling at the cap.

## Final Review

When every task is complete, read `references/final-review.md` and follow it. It covers the whole-branch review, its single fix wave, and how you finish.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Close enough on spec compliance" | Reviewer found spec gaps = not done. Fix or hit the cap and adjudicate: those are the only exits. |
| "I'll fix it myself, dispatching is overhead" | Controller fixes pollute your context and skip review. Resume the implementer. |
| "One more round will converge" | Past the cap, rounds don't converge: the failure is structural. Adjudicate and route. |
| "The reviewer will just find something new anyway" | Scoped re-reviews verify fixes; they cannot wander. New findings on untouched code go to the thread, not the loop. |
| "This finding is obviously wrong, I'll drop it" | You adjudicate only at the cap, and every ruling is a comment. Silent discards are forbidden. |
| "The fix was small, skip the re-review" | Unreviewed fixes are how regressions land. Every round ends with a scoped re-review. |
| "Reviews slow the loop down" | The loop without reviews is just unverified churn. Reviews are the loop's brakes and steering. |
| "Commenting on the task is overhead" | The board is what survives compaction. Controllers without a record have re-dispatched entire completed task sequences. |
| "The implementer spawned its own reviewer, free extra assurance" | It's a duplicate seat reviewing the same diff; the task review is the gate. A worker-spawned reviewer is a defect to flag, not rigor. |
