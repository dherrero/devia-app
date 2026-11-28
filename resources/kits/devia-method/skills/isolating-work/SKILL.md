---
name: isolating-work
description: "Before implementation that should not touch the user's current checkout."
---

# Isolating Work

## Overview

Work that changes code never happens on `main`, `master` or the consolidation branch (`dev`/`develop`). There are two kinds of isolation in Devia:

- **A worktree Devia creates**: for a pane (the user splits the chat to run several sessions at once in the same project) and for a worker when the main agent delegates a kanban task to another agent. Devia gives it its own worktree and branch, tracks it, and removes it when it is no longer needed. Devia owns that worktree.
- **A work branch you create yourself** when you are alone in the user's checkout: gitflow when the repository has a `dev`/`develop` branch, githubflow when it only has `main`/`master`.

**Core principle:** Detect existing isolation first. If there is none, create your own work branch. Never create, move or remove a worktree.

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

**`GIT_DIR != GIT_COMMON` (and not a submodule):** you are in a linked worktree. In Devia that is a pane's or a delegated worker's workspace (or one the user made themselves). You are isolated: skip to Step 2 and work. Report it: "Already isolated at `<path>` on branch `<name>`." Do not create another one.

**`GIT_DIR == GIT_COMMON`:** you are on the user's own checkout. Continue to Step 1.

## Step 1: When You Are on the User's Checkout

You work alone on a branch you create. Do it without asking: it is the default flow, not a favour.

1. **Already on a work branch?** If the current branch is not `main`/`master`/`dev`/`develop` (for example `feat/...` or `fix/...`), keep working on it. Do not create another.
2. **Pick the base.** `git branch --list dev develop` (also check `git branch -r`): if `dev` or `develop` exists, that is the base (gitflow). Otherwise the base is `main` or `master` (githubflow).
3. **Check the tree is clean** (`git status --short`). If it has changes that are not yours, say so and ask before moving them onto a new branch.
4. **Create the branch from the base:** `git checkout -b feat/<slug> <base>` for new behaviour, `fix/<slug>` for a bug, `chore/`, `docs/` or `refactor/` when those fit better. Use the repository's own naming convention if `AGENTS.md` or the history shows one. If the base is behind its remote, say so rather than rebasing silently.
5. Say it in one line: "Working on `feat/<slug>`, created from `<base>`."

Exceptions that need the user:

| Situation | What to do |
|-----------|------------|
| The checkout is the one where the user runs Devia itself and `AGENTS.md` says never to develop in it | Say so and ask for a pane or another checkout. |
| No commits yet, no git, or detached HEAD | Say so and ask before editing in place. |
| Parallel work on independent features | One pane each (see `dispatching-parallel-agents`). |
| A risky spike or work that will run while they do something else | Offer a pane; a pane is never required. |

Never commit on `main`, `master` or the consolidation branch without the user's explicit consent, and never push, open or merge a pull request unless asked.

**What you never do:** create, move, prune or remove a git worktree (`git worktree add`, `remove`, `prune`); create a `.worktrees/` or `worktrees/` directory; switch the branch of a worktree that belongs to a pane or a delegated worker; delete a branch that is not one you created in this session's work. Devia owns worktrees, and one you made is invisible to it.

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
| On the user's checkout, any change | Create `feat/<slug>` or `fix/<slug>` from `dev`/`develop` (or `main`/`master` if there is none) and work there (Step 1) |
| Already on a `feat/`/`fix/` branch | Keep working on it |
| Pane could not get a worktree (no git, no commits) | Devia shows a warning on the pane; say so and ask before editing in place |
| Baseline tests fail | Report failures and ask |
| No package manifest | Skip dependency install |

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'm obviously not in a worktree, no need to check" | Run Step 0. Panes and submodules both fool eyeballing; the commands settle it. |
| "`git worktree add` is quicker" | A worktree you create is phantom state Devia cannot see, track or clean up. Create a branch in the current checkout instead. |
| "I'll just commit on `dev`, it's a small change" | `dev` takes code only by pull request. Create the work branch first, even for one commit. |
| "I'll wait for the user to make the branch" | Creating the branch is part of the job. Only the exceptions in Step 1 need the user. |
| "The workspace is fresh, baseline tests can wait" | A dirty baseline makes every later failure ambiguous. Run the tests now; proceeding past failures is the user's call. |
