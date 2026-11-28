# Project tree

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

File browser in the right rail with git status decorations.

## Does

- `FsProjectTreeReader` (`src/main/features/project-tree/infrastructure/fs-project-tree-reader.ts`) lists a directory lazily, combines `git status` and `git status --ignored` snapshots so ignored entries are hidden and changed files marked; non-git projects (`gitless`) get no decoration.
- Renderer: `src/renderer/app/layout/right-rail/components/project-tree/project-tree.component.ts` with `tree-node`; `devia_pick` selects files on this tree ([ui-tools.md](ui-tools.md)).
- Read-only (no file operations). Follows the focused pane's workdir ([split-view.md](split-view.md)).

## Does NOT

- Does NOT watch the filesystem continuously. Refresh triggers are only: project change, manual refresh button, `process:end`, and `git:info-changed`; a tracked file edited externally with no git activity stays stale until one of those fires.
- Does NOT open files in an editor; opening goes through [shell.md](shell.md).

## Entry points

- `src/main/features/project-tree/index.ts` — wiring
- `src/main/features/project-tree/infrastructure/fs-project-tree-reader.ts:FsProjectTreeReader` — reader
- `src/main/features/project-tree/ipc/project-tree.ipc.ts` — IPC
- `src/shared/domain/project-tree.ts` — types

## IPC / MCP surface

- `projectTree:list`.

## Persistence

None.

## Config

None.

## Gotchas

- Paths are resolved inside the workspace before reading.

## Tests

`src/main/features/project-tree/**/*.test.ts` where present.

## Related

[git.md](git.md), [workspace.md](workspace.md)
