# Git integration

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Git status/diff for the active project, branch switching, one-click pull, and git worktree management for split panes.

## Does

- Info and watcher: `CliGitInspector` (`git:info`, `defaultBranchSync`), `FsGitWatcher` pushes `git:info-changed`; `git:watch` starts watching; `git:diff` and `git:diff-snapshot` (`diff-parser.ts`) feed the inline diff viewer and the Changes view.
- Branch switcher (S-22): `CliGitBrancher.list` (`for-each-ref refs/heads refs/remotes`) feeds the footer modal (`git:list-branches`); `git:checkout` switches the BASE checkout (local `git checkout`, remote `--track`, never `--force`). Renderer guards in `AppStateService.checkoutBranch` block while split view is active or an agent runs.
- Sync/pull: the footer "behind N" chip triggers `git:pull` → `CliGitSyncer.pull` → `git pull --ff-only` (never merges or rebases) through `AppStateService.pullGit` (blocked while an agent runs); `git:sync` is the sync path used by Telegram `/sync`.
- Worktrees (`CliGitWorktreeManager`, `worktree-lifecycle.ts`, `worktree-hooks.ts`): `git:worktree-add`, `git:worktree-list`, `git:worktree-remove`, `git:worktree-cleanup`; session worktrees live under `<deviaDir>/worktrees/<projectKey>/<sessionId>`; session branches are created from the default branch (`config.worktreeBaseRef`).
- Commit traceability: `Spec: S-n-T-n` trailer scan feeds the kanban ([sdd.md](sdd.md)).

## Does NOT

- Does NOT create commits, push, open pull requests, read CI checks, merge or rebase: there is no hosted-review (GitHub/GitLab/Bitbucket) integration, no auto-merge and no PR UI (case-insensitive search of `src/main`, `src/shared`, `src/renderer` for `octokit`, `pull request`, `gh pr`; also nothing for GitLab/Jira/Linear task sources). Agents do those through their own tools.
- Does NOT resolve merge conflicts or amend commits.
- Does NOT switch branches while split view is active or an agent is running (guard in the renderer).
- Does NOT run `git` against the base checkout from isolated panes: their agents are told not to (worktree protocol).

## Entry points

- `src/main/features/git/index.ts:buildGitFeature` — wiring
- `src/main/features/git/infrastructure/cli-git-inspector.ts:CliGitInspector`
- `src/main/features/git/infrastructure/cli-git-brancher.ts:CliGitBrancher`
- `src/main/features/git/infrastructure/cli-git-syncer.ts:CliGitSyncer`
- `src/main/features/git/infrastructure/cli-git-worktree-manager.ts:CliGitWorktreeManager`
- `src/main/features/git/infrastructure/fs-git-watcher.ts`
- `src/main/features/git/infrastructure/diff-parser.ts`
- `src/main/features/git/ipc/git.ipc.ts`
- `src/shared/domain/git.ts` — types
- `src/renderer/app/features/git/` — renderer git views

## IPC / MCP surface

- `git:info`, `git:info-changed`, `git:watch`, `git:diff`, `git:diff-snapshot`, `git:list-branches`, `git:checkout`, `git:pull`, `git:sync`, `git:worktree-add`, `git:worktree-list`, `git:worktree-remove`, `git:worktree-cleanup`.

## Persistence

Worktrees under `<deviaDir>/worktrees/`.

## Config

`worktreeBaseRef`, deprecated `worktreePerSession`.

## Gotchas

- Git is invoked through the shared PATH-aware helper so Windows `.cmd` shims work.
- Session-worktree identity: exec cwd and `WorktreeRef.projectKey` must derive from the absolute checkout; resolve renderer keys with `resolveInsideWorkspace` first.

## Tests

`src/main/features/git/**/*.test.ts`.

## Related

[split-view.md](split-view.md), [chat-ui.md](chat-ui.md), [sdd.md](sdd.md), [../multisesion/02-worktree-lifecycle.md](../multisesion/02-worktree-lifecycle.md)
