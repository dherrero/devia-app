# Split view (multi-session panes + worktrees)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Up to 4 panes (2×2) in one window, each driving its own session and, for additional panes, its own git worktree, with agents running in parallel without touching the same files.

## Does

- `ChatPanesContainerComponent` (`src/renderer/app/features/chat/panes/chat-panes-container.component.ts`) owns the `PanesLayout` (columns × rows), mounts one `ChatPanelComponent` per pane, renders the split icon state machine (vertical → horizontal → none) and the close flow (work-loss modal when the pane's agent runs or its worktree is dirty).
- Session identity: the PRIMARY pane runs on the real checkout (`SessionKey === projectPath`). Every ADDITIONAL pane gets a fresh `sessionId` as its `runKey` and an eagerly created git worktree as cwd; isolation is mandatory (`worktreePerSession` is deprecated and gates nothing). The branch is created from the repo's default branch (`config.worktreeBaseRef: 'default-branch' | 'current'`, resolved by `CliGitInspector.defaultBranchSync`, HEAD fallback).
- Failed worktree (no git / no commits) degrades visibly: warning icon `ds-chat-header [unisolated]` + explicit consent on first send (`AppStateService.acknowledgeUnisolated`).
- Isolated runs get a MANDATORY worktree protocol in the system prompt (`src/main/features/claude-runner/infrastructure/worktree-protocol.ts`): no paths outside cwd, no branch switching, no git against the base checkout.
- The runner keys registry/queue/event dispatch by `runKey ?? projectName`, so two panes of one repo never collide.
- Worktree lifecycle: closing an additional pane with ZERO activity removes worktree and branch (`git:worktree-cleanup`); with activity it uses `git:worktree-remove`, keeping the branch for recovery.
- Recovery chain (`session:adopt` returns `{ workdir, branch?, isolation: 'worktree' | 'recreated' | 'none' }`): live persisted `workdir` → reattach; swept worktree but branch survives → recreate (`reattachWorktreeSync`) + toast "uncommitted lost"; neither → base checkout with `isolation: 'none'`.
- Layout persistence: `PanesLayoutStore` (`panes-layout.store.ts`) keeps the layout per base project in memory and persists a skeleton (arrangement + sessionIds) to localStorage on every commit; after restart `restoreFromDisk()` rebuilds the split through `session:adopt`.
- `PersistedSession` carries `workdir` + `worktreeBranch`, validated by `isLiveSessionWorktree` (exists and contained in `<deviaDir>/worktrees`).
- Focus: `AppStateService.focusedSessionKey` drives which pane the right-rail git/tree and footer reflect; sidebar "Panel" badge.
- Composer drafts per pane survive route changes (`ComposerDraftStore`, `src/renderer/app/features/chat/composer/composer-draft.store.ts`).

## Does NOT

- Does NOT persist composer drafts across app restarts (memory only).
- Does NOT show the terminal while split is active: the terminal runs on the base project (right-rail Terminal tab and `Mod+J` hidden).
- Does NOT allow more than 4 panes, nor sharing one session between two panes.
- Does NOT let an agent create/switch/remove worktrees or session branches on its own initiative (they belong to Devia).

## Entry points

- `src/renderer/app/features/chat/panes/chat-panes-container.component.ts:ChatPanesContainerComponent`
- `src/renderer/app/features/chat/panes/panes-layout.store.ts:PanesLayoutStore`
- `src/renderer/app/features/chat/composer/composer-draft.store.ts:ComposerDraftStore`
- `src/main/features/git/infrastructure/cli-git-worktree-manager.ts` — worktree add/remove
- `src/main/features/git/infrastructure/worktree-lifecycle.ts` — cleanup/recovery
- `src/main/features/sessions/application/adopt-session.use-case.ts:AdoptSessionUseCase`
- `src/main/features/claude-runner/infrastructure/worktree-protocol.ts` — prompt protocol

## IPC / MCP surface

- `git:worktree-add`, `git:worktree-list`, `git:worktree-remove`, `git:worktree-cleanup`, `session:adopt`, `chats:save-as`.

## Persistence

Worktrees in `<deviaDir>/worktrees/<projectKey>/<sessionId>`; layout skeleton in localStorage; session files in `sessions/`.

## Config

`worktreePerSession` (deprecated, no effect), `worktreeBaseRef`.

## Gotchas

- Renderer project ids are workspace-relative keys: the git feature must resolve them with `resolveInsideWorkspace` before building any `WorktreeRef`, else `git worktree add` dies with spawn ENOENT.
- Memory, kanban and code-graph identity use the BASE checkout; the code graph of a worktree is seeded separately ([code-graph.md](code-graph.md)).
- Sessions mounted in panes cannot be switched or deleted while running.

## Tests

- `src/renderer/app/features/chat/panes/*.spec.ts`, `src/main/features/git/ipc/git-worktree.ipc.test.ts`.

## Related

- [sessions.md](sessions.md), [git.md](git.md), [chat-ui.md](chat-ui.md), [../multisesion/01-session-identity.md](../multisesion/01-session-identity.md), [../multisesion/02-worktree-lifecycle.md](../multisesion/02-worktree-lifecycle.md)
