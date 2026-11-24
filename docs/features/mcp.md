# MCP server manager

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Registry, installer, prober and writer of MCP servers: what the user configures in the manager reaches every agent.

## Does

- `McpServerRegistry` loads `mcp-servers.json` at `register()` and `McpConfigWatcher` refreshes it on external edits (#274). Source of truth: `~/.devia-app/mcp-servers.json` (global) or `<project>/.devia/mcp-servers.json` (project scope); writes are atomic (`writeRegistry`).
- `McpServerConfig` (`src/shared/domain/mcp.ts`): `id`, `command`, `args`, `env` (filtered by `allowedEnvKeys`), `enabled`, `agents` (default `['claude']`), `scope` (`global` | `project`), `source` (`npm` | `uvx` | `binary` | `manual`), `pinned`, `startupTimeoutSec` (Codex), `defaultToolsApprovalMode` (Codex), `exposure` (`direct` | `deferred` | `codemode` | `hidden`).
- Per-agent native config targets (`src/main/features/mcp/domain/agent-targets.ts`): claude (`~/.claude.json`, `.mcp.json`; json-merge), codex (`~/.codex/config.toml`, `.codex/config.toml`; toml-merge), gemini (`~/.gemini/settings.json`), opencode (`~/.config/opencode/opencode.json`, `opencode.json`), cursor-agent (`~/.cursor/mcp.json`), copilot (`~/.copilot/mcp-config.json`), qwen (`~/.qwen/settings.json`), grok (`~/.grok/user-settings.json`, `grok-array` strategy: nested `mcp.servers[]`), pi (`~/.pi/agent/mcp.json`, `.pi/mcp.json`). `McpAgentId` has exactly these nine.
- `McpSyncWriter` + `marker-merge.ts` write entries with a `__devia_managed` marker so Devia only touches its own; `BUNDLED_SERVER_IDS` = `devia-memory`, `devia-kanban`, `devia-code-graph`, `devia-ui` are never pruned by the catalog sync unless listed in `removedIds`; Gemini's target sets `jsonOmitMarker` (it rejects the marker key).
- Use cases: install/upsert (`InstallMcpUseCase`, takes a snapshot first), remove, probe (`mcp:probe`), set exposure (`SetMcpExposureUseCase`, `mcp:set-exposure`: Direct vs Via code mode, see [code-mode.md](code-mode.md)).
- Editing: Installed → Edit opens the custom form filled from `mcp:get` (`McpServerRegistry.editView`, the ONE call that returns env VALUES, only when the user opens the form); saving goes through the same `mcp:install` upsert, keeping `exposure`/`createdAt`/`pinned`, and removes the server from any agent that was unticked. Id and scope are locked while editing; args accept double quotes (`splitArgs`/`joinArgs`).
- Claude: the temp `--mcp-config` file builder (`infrastructure/temp-config-writer.ts`) and per-project grants (`grantClaudeMcpAccess` in `src/main/shared/claude-defaults.ts`, writes `permissions.allow += mcp__<id>` and, for project-scope `.mcp.json` servers, `enabledMcpjsonServers`). Enterprise managed config (`managed-mcp.json`) disables injection ([claude-runner.md](claude-runner.md)).

## Does NOT

- Does NOT write config for agents with no target: deepseek, qoder, kimi, hermes (ACP agents get servers through `session/new.mcpServers`), so an agent that cannot load MCP while the user configured servers gets a status notice.
- Does NOT forward MCP `http`/`sse` servers to ACP agents (stdio only).
- Does NOT hot-load into a running agent: a change applies from the next run.
- Does NOT block engram for non-Claude agents (only Claude has `--strict-mcp-config`); the Settings UI warns.
- Does NOT auto-allow hand-edited `.mcp.json` entries (it adds specific ids, never `enableAllProjectMcpServers`).

## Entry points

- `src/main/features/mcp/index.ts:buildMcpFeature` — wiring
- `src/main/features/mcp/domain/registry.ts:McpServerRegistry`
- `src/main/features/mcp/domain/agent-targets.ts:resolveAgentTarget`
- `src/main/features/mcp/infrastructure/mcp-sync-writer.ts:McpSyncWriter`
- `src/main/features/mcp/infrastructure/marker-merge.ts:BUNDLED_SERVER_IDS`
- `src/main/features/mcp/application/install-mcp.use-case.ts:InstallMcpUseCase`
- `src/main/features/mcp/application/set-mcp-exposure.use-case.ts:SetMcpExposureUseCase`
- `src/main/features/mcp/ipc/mcp.ipc.ts`
- `src/renderer/app/features/mcp/mcp-modal.component.ts` — manager UI

## IPC / MCP surface

- `mcp:get`, `mcp:install`, `mcp:remove`, `mcp:probe`, `mcp:sync`, `mcp:set-exposure`, `mcp:list-changed`.

## Persistence

`~/.devia-app/mcp-servers.json`, `<project>/.devia/mcp-servers.json`, `~/.devia-app/tmp/mcp-<uuid>.json` (ephemeral, swept at startup, 24 h TTL), agent-native config files above.

## Config

`config.memory.blockEngram` (Claude `--strict-mcp-config`), `DEVIA_ASSUME_ENTERPRISE_MCP=1|0` override.

## Gotchas

- Native-config delivery of Devia's own servers is ONE write per run (`NativeConfigMcpDelivery`, `prune: false`); the manager sync (`prune: true`) never prunes bundled ids. This fixed the bug where each injector deleted the server the previous one wrote.
- Codex's default 10 s MCP startup timeout drops Devia's Electron-spawned servers silently, so bundled servers set `startupTimeoutSec`.
- Grok's config is GLOBAL (`~/.grok/user-settings.json`); sandbox `HOME` in any script or test that delivers to grok.
- The old S-24 `devia-ask` entry is retired on every delivery (only entries with the `__devia_managed` marker).

## Tests

`src/main/features/mcp/mcp.test.ts`, `src/main/features/mcp/domain/agent-targets.test.ts`, `src/main/features/mcp/infrastructure/*.test.ts`.

## Related

[../mcp/01-cli-paths-audit.md](../mcp/01-cli-paths-audit.md), [../mcp/02-scope-decision.md](../mcp/02-scope-decision.md), [agents.md](agents.md), [code-mode.md](code-mode.md), [snapshot.md](snapshot.md), [../reference/mcp-servers.md](../reference/mcp-servers.md)
