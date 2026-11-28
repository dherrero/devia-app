# SDD board (`devia-kanban`)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Spec-driven development: a per-project kanban of specs and tasks that the agent drives through MCP tools and the user watches live.

## Does

- Storage `~/.devia-app/projects/<key>/kanban.json` via `KanbanStore`; `KanbanUseCase` implements the board; `KanbanWatcher` reflects MCP-side mutations into the UI (`kanban:changed`). State never lives in the repo.
- `devia-kanban` MCP server (`src/main/features/sdd/mcp-server/server.ts`, `kanban-tools.ts:KANBAN_TOOLS`): `kanban_create_spec`, `kanban_create_task`, `kanban_list`, `kanban_list_specs`, `kanban_get_task`, `kanban_update_task`, `kanban_move_task`, `kanban_comment`, `kanban_close_task`, `kanban_request_user_input`, `kanban_record_subagent`, `kanban_archive_spec`, `kanban_reopen_spec` (13).
- Empty-board tool gating: `tools/list` advertises only `kanban_create_spec` and `kanban_create_task` while the board has 0 specs and 0 tasks (`advertisedKanbanTools`), saving ~2k tokens per turn; `callKanbanTool` still dispatches the full set.
- `kanban_list` is paginated and filtered (`specId`, `column`, `includeArchived`, `verbose`, `limit` default 30, `offset`) and returns lightweight cards unless `verbose`; `kanban_list_specs` is the cheapest overview.
- `kanban_update_task` edits title/body/specId/dependsOn and re-runs the dependency block state (clearing the last unmet dependency unblocks; adding one blocks a live task). Tasks are `backlog | todo | in_progress | blocked | done`; a task with unmet `dependsOn` is created blocked.
- Archive: `kanban_archive_spec` is a logical delete (`archivedAt`) refused with open tasks unless `force`; archived specs are hidden from every list and the UI unless `includeArchived`. The board UI shows "Spec finished · Close spec" when a single-spec filter has every task done (`kanban:archive-spec`). Reopen is MCP-only.
- Commit ⇄ task traceability: closing commits carry a `Spec: S-<n>-T-<n>` trailer; `scanCommitLinks` folds recent git history into each task's `linkedCommits` (`src/main/features/sdd/commit/commit-footer.ts`).
- Planner/bootstrap: `PrepareUseCase` turns a bootstrap decision (`newProject` flag in the per-project cache) into an agent instruction for new (`init`, creates the first spec) or existing (`prepare`, analyse + backlog) projects; the renderer dispatches it through `sendInstruction`.
- Notifications: `board-reconciler.ts` and `notification-store.ts` raise board events (`sdd:notification*` channels).
- In plan mode the plan protocol makes the agent persist the plan on the board (one spec, one task per step in `todo`, `dependsOn`) before `devia_plan_approve` ([run-modes.md](run-modes.md)).

## Does NOT

- Does NOT run the tasks itself: the active agent executes them; there is no Devia-side orchestrator (spec S-26 `devia_spawn_agent` is blocked, not implemented).
- Does NOT let the board edit a spec after creation (only archive/reopen); tasks can be edited.
- Does NOT keep the board in the repository or export specs to files.
- Does NOT migrate orphan boards created under worktree keys (fixed going forward by base-checkout identity).
- The renderer hides archived specs automatically; reopen has no UI.

## Entry points

- `src/main/features/sdd/index.ts:buildSddFeature` — wiring
- `src/main/features/sdd/kanban/application/kanban.use-case.ts:KanbanUseCase`
- `src/main/features/sdd/kanban/infrastructure/kanban-store.ts:KanbanStore`
- `src/main/features/sdd/mcp-server/kanban-tools.ts:KANBAN_TOOLS`
- `src/main/features/sdd/mcp-server/kanban-mcp-injector.ts` — server config
- `src/main/features/sdd/watch/kanban-watcher.ts:KanbanWatcher`
- `src/main/features/sdd/prepare/prepare.use-case.ts:PrepareUseCase`
- `src/main/features/sdd/commit/commit-footer.ts` — trailer parsing
- `src/main/features/sdd/ipc/sdd.ipc.ts`
- `src/renderer/app/features/kanban/kanban-modal.component.ts` — board UI

## IPC / MCP surface

- MCP tools above; IPC `kanban:board`, `kanban:task`, `kanban:create-task`, `kanban:update-task`, `kanban:move-task`, `kanban:comment`, `kanban:close-task`, `kanban:block-task`, `kanban:unblock-task`, `kanban:delete-task`, `kanban:archive-spec`, `kanban:mark-read`, `kanban:agent-wake`, `kanban:changed`, `sdd:bootstrap`, `sdd:prepare`, `sdd:create-spec`, `sdd:notifications:*`, `sdd:notification`, `sdd:notify-os`, `sdd:mark-engaged`, `sdd:mark-handled`.

## Persistence

`~/.devia-app/projects/<key>/kanban.json`; `newProject` flag in the per-project cache.

## Config

None.

## Gotchas

- Identity is the BASE checkout (a session worktree path would fragment boards).
- The server is injected for every Claude run (the planner needs it even in plan mode), hence the empty-board gating.
- The Devia Method keeps its plan, ledger and "done" state on this board (no plan or ledger files): see [starter-kits.md](starter-kits.md).

## Tests

`src/main/features/sdd/**/*.test.ts`.

## Related

[starter-kits.md](starter-kits.md), [run-modes.md](run-modes.md), [ui-tools.md](ui-tools.md), [../reference/mcp-servers.md](../reference/mcp-servers.md)
