# IPC channels

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

Generated from `src/shared/contracts/ipc-channels.ts` (`IPC` const, 196 channels). The contract file is the source of truth; main → renderer events are typed separately in `src/shared/contracts/events.ts`. Direction is not encoded here: see each feature page.

| Prefix | Channels (constant → name) |
| --- | --- |
| `agent` | `agent:select`, `agent:setModel`, `agent:setEnv`, `agent:test`, `agent:changed` |
| `agents` | `agents:list` |
| `app` | `app:version` |
| `audit` | `audit:read` |
| `autoresume` | `autoresume:cancel` |
| `bases` | `bases:list`, `bases:read-json`, `bases:write-json` |
| `chats` | `chats:loadAll`, `chats:save`, `chats:save-as` |
| `claude` | `claude:output` |
| `clone` | `clone:run`, `clone:start`, `clone:output`, `clone:end` |
| `code-graph` | `code-graph:status`, `code-graph:index`, `code-graph:cancel`, `code-graph:reset`, `code-graph:set-agent-access`, `code-graph:set-auto-update`, `code-graph:update`, `code-graph:watch`, `code-graph:unwatch`, `code-graph:progress`, `code-graph:status-changed`, `code-graph:overview`, `code-graph:expand`, `code-graph:node-detail`, `code-graph:search`, `code-graph:usage` |
| `compose` | `compose:run`, `compose:start`, `compose:output`, `compose:end`, `compose:detect`, `compose:search` |
| `config` | `config:get`, `config:set`, `config:changed` |
| `dialog` | `dialog:pickFolder`, `dialog:pickFile` |
| `docker` | `docker:detect` |
| `folder` | `folder:new`, `folder:rename` |
| `git` | `git:info`, `git:watch`, `git:info-changed`, `git:diff`, `git:sync`, `git:pull`, `git:list-branches`, `git:checkout`, `git:worktree-add`, `git:worktree-remove`, `git:worktree-cleanup`, `git:worktree-list`, `git:diff-snapshot` |
| `instruction` | `instruction:send` |
| `kanban` | `kanban:board`, `kanban:task`, `kanban:create-task`, `kanban:update-task`, `kanban:move-task`, `kanban:close-task`, `kanban:delete-task`, `kanban:archive-spec`, `kanban:block-task`, `kanban:unblock-task`, `kanban:comment`, `kanban:mark-read`, `kanban:changed`, `kanban:agent-wake` |
| `mcp` | `mcp:install`, `mcp:remove`, `mcp:sync`, `mcp:probe`, `mcp:get`, `mcp:set-exposure`, `mcp:list-changed` |
| `memory` | `memory:detect-engram`, `memory:import-engram`, `memory:search`, `memory:list`, `memory:list-sessions`, `memory:set-pinned`, `memory:forget`, `memory:clear` |
| `outbox` | `outbox:file` |
| `pinned` | `pinned:get`, `pinned:set` |
| `process` | `process:start`, `process:end`, `process:stop`, `process:stop-all` |
| `project` | `project:new`, `project:new-base`, `project:trash`, `project:move` |
| `projectTree` | `projectTree:list` |
| `projects` | `projects:list`, `projects:search` |
| `promptPacks` | `promptPacks:list`, `promptPacks:rescan` |
| `question` | `question:ask`, `question:answer` |
| `queue` | `queue:list`, `queue:add`, `queue:remove`, `queue:edit`, `queue:move`, `queue:clear`, `queue:pause`, `queue:resume`, `queue:changed`, `queue:dispatched` |
| `remoteControl` | `remoteControl:get-status`, `remoteControl:test`, `remoteControl:restart`, `remoteControl:status` |
| `run` | `run:cancel` |
| `runMode` | `runMode:get`, `runMode:set`, `runMode:changed` |
| `saas` | `saas:baseUrl` |
| `sdd` | `sdd:bootstrap`, `sdd:prepare`, `sdd:create-spec`, `sdd:mark-handled`, `sdd:mark-engaged`, `sdd:notifications:get`, `sdd:notifications:clear`, `sdd:notifications:mark-read`, `sdd:notification`, `sdd:notify-os` |
| `session` | `session:reset`, `session:switch`, `session:delete`, `session:handoff`, `session:adopt` |
| `session-import` | `session-import:scan`, `session-import:run` |
| `sessions` | `sessions:list`, `sessions:active-stats` |
| `shell` | `shell:openPath`, `shell:reveal`, `shell:openInIde`, `shell:listIdes`, `shell:open-upgrade` |
| `skillRegistry` | `skillRegistry:status`, `skillRegistry:refresh`, `skillRegistry:watch`, `skillRegistry:changed`, `skillRegistry:read` |
| `skills` | `skills:list`, `skills:install`, `skills:remove`, `skills:discover`, `skills:cancel-discovery` |
| `snapshot` | `snapshot:list`, `snapshot:restore`, `snapshot:pin`, `snapshot:delete` |
| `starter-kits` | `starter-kits:status`, `starter-kits:set` |
| `stats` | `stats:aggregate` |
| `status` | `status:get` |
| `subAgents` | `subAgents:list`, `subAgents:install`, `subAgents:remove`, `subAgents:autoImport`, `subAgents:changed` |
| `terminal` | `terminal:start`, `terminal:write`, `terminal:resize`, `terminal:stop`, `terminal:data`, `terminal:exit` |
| `ui` | `ui:tool-request`, `ui:tool-result` |
| `uiTools` | `uiTools:catalog`, `uiTools:grants`, `uiTools:revoke` |
| `update` | `update:check`, `update:install`, `update:status` |
| `voice` | `voice:transcribe` |
| `window` | `window:minimize`, `window:toggle-maximize`, `window:close`, `window:is-maximized` |

## Related

- [../architecture/process-and-ipc.md](../architecture/process-and-ipc.md), feature pages for semantics.
