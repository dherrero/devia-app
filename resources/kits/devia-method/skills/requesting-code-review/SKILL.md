---
name: requesting-code-review
description: "Work is done or a task is closed: get it reviewed before it goes further."
---

# Requesting Code Review

Dispatch a code reviewer subagent to catch issues before they cascade. The reviewer gets precisely crafted context for evaluation — never your session's history.

**Core principle:** Review early, review often.

## When to Request Review

**Mandatory:**
- After each task in `subagent-driven-development`
- After completing major feature
- Before merge to main

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing complex bug

## How to Request

**1. Get git SHAs:** the BASE you recorded before the work started (never guess `HEAD~1`: it drops all but the last commit of a multi-commit task), or the fork point for a whole branch.
```bash
BASE_SHA=$(git merge-base origin/main HEAD)  # or the BASE you recorded
HEAD_SHA=$(git rev-parse HEAD)
```

**2. Dispatch code reviewer subagent** (when your agent has a subagent tool; otherwise read `code-reviewer.md` and do the review yourself as a separate pass, and say so):

Dispatch a `general-purpose` subagent, filling the template at `code-reviewer.md` in this directory. Log it with `kanban_record_subagent` on the task.

**Placeholders:**
- `{DESCRIPTION}` - Brief summary of what you built
- `{PLAN_OR_REQUIREMENTS}` - What it should do: the kanban task id (the reviewer reads it with `kanban_get_task`), or the requirements pasted
- `{BASE_SHA}` - Starting commit
- `{HEAD_SHA}` - Ending commit

**3. Ask the user for their review** when the work is finished (not after every task): `devia_request_review` shows the diff in the Changes view and returns their decision and line comments. An empty diff answers by itself. Handle what comes back with `receiving-code-review`.

**4. Act on feedback:**
- Fix Critical issues immediately
- Fix Important issues before proceeding
- Note Minor issues for later
- Push back if reviewer is wrong (with reasoning)

## Example

```
[Just closed Task 2: Add verification function]

You: Let me request code review before proceeding.

BASE_SHA=a7981ec  # recorded before Task 2 started
HEAD_SHA=$(git rev-parse HEAD)

[Dispatch code reviewer subagent]
  DESCRIPTION: Added verifyIndex() and repairIndex() with 4 issue types
  PLAN_OR_REQUIREMENTS: kanban task T-14 (Task 2 of the deployment plan)
  BASE_SHA: a7981ec
  HEAD_SHA: 3df7661

[Subagent returns]:
  Strengths: Clean architecture, real tests
  Issues:
    Important: Missing progress indicators
    Minor: Magic number (100) for reporting interval
  Assessment: Ready to proceed

You: [Fix progress indicators]
[Continue to Task 3]
```

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'll just review the diff myself instead of dispatching a reviewer" | You're the coordinator — reviewing the diff inline burns the context window you need to keep driving the work. Dispatch a reviewer subagent: the diff and the evaluation live in its context, and only the findings come back to you. |
| "The reviewer needs my whole session history to understand the change" | Hand it precisely crafted context, never your session's history. That keeps the reviewer on the work product, not your thought process. |

## Red Flags

**Never:**
- Skip review because "it's simple"
- Ignore Critical issues
- Proceed with unfixed Important issues
- Argue with valid technical feedback

**If reviewer wrong:**
- Push back with technical reasoning
- Show code/tests that prove it works
- Request clarification

See template at: `code-reviewer.md`
