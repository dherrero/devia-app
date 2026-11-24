# Workspace (config, projects, bases)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Owns the user configuration file, the workspace root (the folder holding all projects), project listing/search/creation/move/trash, "new from base" templates and tech detection.

## Does

- Config persistence (`FsConfigRepository`, `~/.devia-app/devia-app.config.json`); `GetConfigUseCase` / `SetConfigUseCase`; `config:changed` is pushed on change.
- Lists projects under `workspaceRoot` (`FsWorkspaceScanner`, honours `ignoreFolders`), nested folders, search (`projects:search`), tech icons via `FsTechDetector` (`src/shared/domain/tech-catalog.ts`).
- Creates an empty project (`NewProjectUseCase`), a project from a base template (`NewFromBaseUseCase`, `bases.json` through `FsBasesStore`), a folder, renames a folder, moves a project (`MoveProjectUseCase`), trashes a project (`TrashProjectUseCase`).
- Project bootstrap: a new project runs `git init`; a project created from a base runs `git init`, `git add .` and a first commit (`gitInitAndFirstCommit` in `src/main/features/workspace/infrastructure/node-project-file-system.ts`, the only place Devia itself commits). Both write per-agent defaults (`ensureAgentDefaults` → `src/main/shared/agent-defaults.ts`): Claude `.claude/settings.local.json` permissions baseline, Codex trust entry in `$CODEX_HOME/config.toml` so the project-scoped `.codex/config.toml` (where Devia injects MCP servers) loads.
- Pickers: `dialog:pickFolder`, `dialog:pickFile` (`ElectronDialogService`).
- All user-supplied paths go through `resolveInsideWorkspace` (`src/main/shared/workspace-paths.ts`) before any filesystem operation; project identity strings are workspace-relative keys (`ProjectEntry.path`).
- Bases editor lives in Settings → Templates (`bases:read-json`, `bases:write-json`).

## Does NOT

- Does NOT watch the workspace for external changes: no watcher exists in `src/main/features/workspace` (searched for `watch`); the list is re-read on demand.
- Does NOT support multiple workspaces at once: one `workspaceRoot`.
- Does NOT delete projects permanently: `project:trash` calls Electron `shell.trashItem` (OS trash) and also drops the trashed project's sessions (cascading for folders).
- A first-run modal asks for the workspace; there is no automatic project import from git hosts besides [clone.md](clone.md).

## Entry points

- `src/main/features/workspace/index.ts:buildWorkspaceFeature` — wiring
- `src/main/features/workspace/application/list-projects.use-case.ts` — listing
- `src/main/features/workspace/application/new-from-base.use-case.ts` — base templates
- `src/main/features/workspace/infrastructure/fs-config-repository.ts` — config file
- `src/main/features/workspace/infrastructure/fs-tech-detector.ts:FsTechDetector` — tech detection
- `src/main/features/workspace/ipc/workspace.ipc.ts` — IPC
- `src/main/shared/workspace-paths.ts` — containment helper
- `src/shared/domain/config.ts:DeviaConfig` — config shape

## IPC / MCP surface

- `projects:list`, `projects:search`, `project:new`, `project:new-base`, `project:trash`, `project:move`, `folder:new`, `folder:rename`, `bases:list`, `bases:read-json`, `bases:write-json`, `config:get`, `config:set`, `config:changed`, `dialog:pickFolder`, `dialog:pickFile`.

## Persistence

- `~/.devia-app/devia-app.config.json` (config), `~/.devia-app/bases.json` (templates). The project folders themselves live under `workspaceRoot`.

## Config

`workspaceRoot`, `ignoreFolders`, `language`, theme settings; full list in [../reference/config.md](../reference/config.md).

## Gotchas

- Passing a raw workspace-relative key as cwd to git made every `git worktree add` die with ENOENT: git code must resolve it with `resolveInsideWorkspace` first.
- Secrets in config (agent env, Telegram token) are stored through `secret-vault` ([security.md](security.md)).

## Tests

- `src/main/features/workspace/**/*.test.ts`.

## Related

- [clone.md](clone.md), [pinned-projects.md](pinned-projects.md), [project-tree.md](project-tree.md), [settings.md](settings.md), [../reference/config.md](../reference/config.md)
