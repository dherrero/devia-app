---
name: isolating-work
description: "Before implementation that should not touch the user's current checkout."
---

# Isolating Work

## Overview

Work that changes code happens in an isolated workspace. In Devia the isolation is a **pane**: the user splits the chat, and Devia gives that pane its own git worktree and its own session branch, created from the repository's default branch. Devia creates it, tracks it, and removes it when the pane is closed or the session deleted.

**Core principle:** Detect existing isolation first. Ask for a pane when you need one. Never build isolation yourself.

**Announce at start:** "I'm using the isolating-work skill to check where this work happens."

## Step 0: Detect Existing Isolation

Before anything else, find out where you are:

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
BRANCH=$(git branch --show-current)
```

**Submodule guard:** `GIT_DIR != GIT_COMMON` is also true inside a git submodule. If this prints a path, you are in a submodule and should treat it as a normal checkout:

```bash
git rev-parse --show-superproject-working-tree 2>/dev/null
```

**`GIT_DIR != GIT_COMMON` (and not a submodule):** you are in a linked worktree. In Devia that is a pane's workspace (or one the user made themselves). You are isolated: skip to Step 2 and work. Report it: "Already isolated at `<path>` on branch `<name>`." Do not create another one.

**`GIT_DIR == GIT_COMMON`:** you are on the user's own checkout. Continue to Step 1.

## Step 1: When You Are on the User's Checkout

Isolation is not always worth a pane. Decide by what the work is:

| The work | What to do |
|----------|------------|
| A small, focused change; the user is watching | Work in place, on the branch they have checked out, **after they agree**. |
| A multi-file feature, a risky refactor, a spike, or anything that will run while they do something else | Ask them to split the chat into a pane. |
| Parallel work on independent features | One pane each (see `dispatching-parallel-agents`). |

How to ask, in plain words: "This touches several files. Want to split the view so I work in its own pane? Devia gives it a separate worktree and branch, and your checkout stays as it is." The split button is in the chat header. Wait for them; the work continues in the new pane.

Never start implementation on `main` or `master` without the user's explicit consent.

**What you never do:** create, move, prune or remove a git worktree (`git worktree add`, `remove`, `prune`); create a `.worktrees/` or `worktrees/` directory; switch the branch of a checkout that is not yours; delete a session branch. Devia owns all of that, and a worktree you made is invisible to it.

## Step 2: Project Setup

In the workspace you will use, run the setup the project needs:

```bash
# Node.js
if [ -f package.json ]; then npm install; fi

# Rust
if [ -f Cargo.toml ]; then cargo build; fi

# Python
if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
if [ -f pyproject.toml ]; then poetry install; fi

# Go
if [ -f go.mod ]; then go mod download; fi
```

Skip anything the project does not have. A pane starts from the default branch, so dependencies may be missing even where the user's checkout has them.

## Step 3: Verify a Clean Baseline

Run the project's tests before you change anything, so every later failure is unambiguous:

```bash
# Use the project-appropriate command
npm test / cargo test / pytest / go test ./...
```

**If tests fail:** report the failures and ask whether to proceed or investigate.

**If they pass:** report "Isolated at `<path>` on `<branch>`; tests passing (N tests, 0 failures); ready to implement `<feature>`."

## Quick Reference

| Situation | Action |
|-----------|--------|
| Already in a linked worktree | Skip to setup (Step 0) |
| In a submodule | Treat as a normal checkout (Step 0 guard) |
| On the user's checkout, small change | Work in place with their agreement |
| On the user's checkout, bigger work | Ask for a pane (Step 1) |
| Pane could not get a worktree (no git, no commits) | Devia shows a warning on the pane; say so and ask before editing in place |
| Baseline tests fail | Report failures and ask |
| No package manifest | Skip dependency install |

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'm obviously not in a worktree, no need to check" | Run Step 0. Panes and submodules both fool eyeballing; the commands settle it. |
| "`git worktree add` is quicker than asking for a pane" | A worktree you create is phantom state Devia cannot see, track or clean up. Ask for the pane. |
| "I'll just branch off here, it's the same thing" | A branch on the user's checkout moves their working tree under them. |
| "The workspace is fresh, baseline tests can wait" | A dirty baseline makes every later failure ambiguous. Run the tests now; proceeding past failures is the user's call. |
