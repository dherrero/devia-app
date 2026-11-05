---
name: finishing-work
description: "Implementation is done and green: verify, hand it to the user, close the loop."
---

# Finishing Work

## Overview

Close the loop on finished work: prove it works, get it reviewed, let the user decide what happens to it, and leave the board and memory true.

**Core principle:** Verify tests → review → the user chooses → close the tasks → remember.

**Announce at start:** "I'm using the finishing-work skill to complete this work."

## Step 1: Verify Tests

Run the project's full test suite (`npm test` / `cargo test` / `pytest` / `go test ./...`). Load `verification-before-completion` first if you have not this turn.

**If tests fail**, report the failures and stop: everything after this comes after a green suite.

```
Tests failing (<N> failures). Must fix before completing:

[Show failures]
```

**If tests pass:** continue.

## Step 2: Know Where You Are

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
BRANCH=$(git branch --show-current)
```

- `GIT_DIR != GIT_COMMON`: you are in a pane's worktree on a session branch. **It belongs to Devia.** Leave the worktree and the branch exactly where they are, always: the user may keep iterating there, and Devia removes them when the pane or session is closed.
- `GIT_DIR == GIT_COMMON`: you worked on the user's own checkout, on `<branch>`.
- `BRANCH` empty: detached HEAD. Commit your work, and say that it needs a branch before it can be pushed.

Everything is committed? `git status --porcelain` is empty, or the leftovers are named and explained to the user.

## Step 3: Get It Reviewed

Ask for the human review with `devia_request_review` (apply mode): it shows the diff in the Changes view, where the user comments on lines, and the answer comes back as their decision. An empty diff answers by itself. If the user comes back with comments, handle them with `receiving-code-review`, then ask again. If the card isn't offered, say what changed and ask in plain text.

For a plan executed with `executing-plans` or `subagent-driven-development`, the whole-branch review already happened; this review is the user's.

## Step 4: Present Options

Ask with `devia_ask_user` (or in plain text if cards aren't offered) and wait. The integration decision is theirs:

```
Implementation complete and reviewed. What would you like to do?

1. Leave it ready — I stop here; you merge or open a PR from Devia whenever you like
2. Push the branch
3. Push the branch and open a pull request
```

Present exactly these. Never merge into the base branch, never delete a branch, never discard work on your own: if the user asks to throw the work away, tell them to close the pane or delete the session in Devia, which removes the worktree and its branch for them.

## Step 5: Execute the Choice

**1. Leave it ready:** report "Work is committed on `<branch>` (`<N>` commits since `<base>`)." and nothing else.

**2. Push the branch:**

```bash
git push -u origin <branch>
# From a detached HEAD, name the new branch on the remote:
# git push origin HEAD:refs/heads/<new-branch>
```

**3. Push and open a pull request:** push as above, then create the pull request against `<base-branch>` with the forge's own tooling (its CLI if one is available, or the creation URL most forges print on push), following the repository's PR template and conventions, and report the URL. Confirm the base branch with the user if it is not obvious: a pull request against the wrong base is expensive to undo.

A rejected push means the remote moved. Investigate; force-push only when the user asks for it in so many words.

## Step 6: Close the Loop

- Every task of the plan that is not closed yet: `kanban_close_task` with its commit. When every task of the spec is `done`, tell the user and offer to archive the spec (`kanban_archive_spec`, only after they say yes; Devia also offers it on the board).
- Decisions, root causes and lessons that will outlive this session: `mem_save` (the memory protocol says which type).
- `mem_session_summary` with the goal, what was done, what was decided, what is next, and the files that matter.
- The final message names what is left: deferred minors, rulings you made, anything not verified.

## Quick Reference

| Option | Commit | Push | PR | Touches worktree/branch |
|--------|--------|------|----|--------------------------|
| 1. Leave it ready | yes | - | - | never |
| 2. Push | yes | yes | - | never |
| 3. Push and PR | yes | yes | yes | never |

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Tests passed earlier this session" | Run the suite on the tree you are about to hand over. A green run only proves the tree it ran on. |
| "They obviously want it merged" | Integration is the user's decision. Present the options and wait. |
| "They seem done with this feature, I'll offer to discard it" | You never discard. If they ask, they close the pane in Devia. |
| "The PR is up, so the worktree is clutter now" | PR feedback gets fixed in that worktree. It stays until the user closes the pane. |
| "This worktree looks stale, I'll clean it" | Every worktree here belongs to Devia, including ones whose path contains `worktrees/`. Leave them. |
| "The push was rejected, force-push will fix it" | A rejected push means the remote moved. Investigate; force-push only on the user's explicit request. |
| "The base branch is obviously main" | Confirm the fork point or ask. A pull request against the wrong base is expensive to undo. |
| "The board can be tidied later" | Tasks closed without a commit and a session without a summary are how the next agent starts blind. |
