# Worktree lifecycle (S-13 T-154)

## Cleanup primitive — `cleanupSession`

`cleanupSession(ref, exec?)` is a **synchronous, best-effort** function that
removes one session's worktree and its associated session branch. It lives in
`src-main/features/git/infrastructure/worktree-lifecycle.ts`.

Steps (all best-effort — failures are swallowed, never re-thrown):

1. `git worktree remove --force <ref.worktreeDir>` (cwd = `ref.baseProject`)
2. `git worktree prune` (cwd = `ref.baseProject`)
3. `git branch -D <ref.branch>` (cwd = `ref.baseProject`)

Returns `{ removed: boolean; branchDeleted: boolean }`.

### Why force-delete the branch

The session branch (`devia/session-<8char>`) is a scratch branch created
exclusively for one concurrent panel. Its only purpose is to keep the agent's
work-in-progress commits in an isolated linked worktree while the session is
active. `cleanupSession` is called **after** the merge-or-discard decision
(T-143's panel-close flow); at that point the useful work has either been
merged into the base branch or discarded, so the scratch branch is safe to
force-delete. An unmerged scratch branch is treated as abandoned — the user
chose to discard. `-D` (force) avoids a git error when unmerged commits remain.

## Startup sweep — `sweepOrphans`

`sweepOrphans(deviaDir, liveWorktreeDirs?, exec?, fsOps?)` runs once in
`git.onReady()` and removes worktree directories under
`<deviaDir>/worktrees/<projectKey>/<sessionId>/` that are not in
`liveWorktreeDirs`.

At cold start the live set is empty: no session has been restored yet, so every
leftover directory is an orphan from a previous crash or unclean close.
T-143's layout-persistence layer will later pass the restored session dirs so
that revived sessions are preserved.

For each orphan the strategy is:

1. `git -C <worktreeDir> rev-parse --git-common-dir` → derive the base repo
   path, then `git worktree remove --force` + `git worktree prune` so git's
   administrative refs inside `<base>/.git/worktrees/` are cleaned up properly.
2. If step 1 fails (broken directory, not a git worktree) → `fs.rmSync` as a
   last-resort disk reclaim.

### Why the sweep runs regardless of the `worktreePerSession` flag

Leftover worktrees can exist because the flag was on in a previous run and is
now off, or because the app crashed before teardown. The worktrees root simply
will not exist if the feature was never used, making the sweep a cheap no-op in
that case. Running unconditionally prevents orphan accumulation after the flag
is toggled.

## node_modules decision

**Do nothing.** Each worktree is created without `node_modules` and none are
created, symlinked, or copied by Devia. Rationale: a symlink shares mutable
state and is fragile on Windows; a full copy is slow and disk-heavy with up to
4 concurrent worktrees. Agents reinstall only if they actually need to run
package-manager commands, which keeps the create path instant and cross-platform.

Disk and time impact with 4 concurrent worktrees (worst-case):

- Create: near-instant (git worktree add copies only the index, not the
  working tree; no `node_modules` are copied).
- Disk: one copy of `node_modules` per worktree **only if** the agent runs
  `npm install`; otherwise zero overhead beyond the worktree index.
- Cleanup: rmSync + worktree prune; sub-second for an empty worktree, O(seconds)
  if `node_modules` was installed.

The one-line code comment in `cli-git-worktree-manager.ts`/`ensureWorktreeSync`
(and `worktree-lifecycle.ts`) documents this decision at the creation and
cleanup sites.
