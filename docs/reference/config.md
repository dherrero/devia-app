# Configuration (`DeviaConfig`)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

File: `~/.devia-app/devia-app.config.json`, type `DeviaConfig` in `src/shared/domain/config.ts`, defaults `DEFAULT_CONFIG`. Persisted by `FsConfigRepository` (`src/main/features/workspace/infrastructure/fs-config-repository.ts`), which deep-merges `memory`, migrates legacy keys on load and seals secrets. The renderer receives `DeviaConfigView` (adds `configPath`, `hasWorkspace`) with secrets redacted.

| Key | Type / default | Meaning |
| --- | --- | --- |
| `workspaceRoot` | `string`, `''` | root folder holding all projects (empty until the first-run modal) |
| `ignoreFolders` | `string[]`, `[]` | folders hidden from project listing |
| `agentId` | `string`, `'claude'` | active CLI agent; validated at startup and on `agent:select`, falls back to `claude` |
| `agentModels` | `Record<agentId, {model?, reasoning?}>`, `{}` | per-agent model and effort |
| `agentCliEnv` | `Record<agentId, Record<string,string>>`, `{}` | per-agent env overrides; only keys in the def's `envOverrideKeys` reach the child; UI masks values |
| `agentToolPolicy` | `Record<agentId, {disallow?, allow?}>`, `{}` | per-agent tool restrictions layered on the def's defaults (denylist wins) |
| `language` | `string?` | UI language code; unset ⇒ OS detection ([i18n.md](i18n.md)) |
| `autoContinueSessions` | `Record<agentId, boolean>?` | resume after usage limit ([../features/auto-continue.md](../features/auto-continue.md)) |
| `lastProjectPath` | `string?` | workspace-relative path reopened at launch |
| `memory` | `{enabled, blockExternalMemory, engramImported, engramImportedAt?}`; defaults `true`, `true`, `false` | memory feature; `blockExternalMemory` renamed from `blockEngram` (migrated) |
| `starterKits` | `StarterKitsConfig?` | per-kit `{enabled, projects[], introSeen}`; absent = no decision yet |
| `remoteControl` | `{allowShell:false, mirrorDesktop:false, allowFileSend:true, telegram:{enabled:false, botToken:'', chatId:''}}` | Telegram remote control ([../features/telegram-controller.md](../features/telegram-controller.md)) |
| `uiTools` | `{enabled: Partial<Record<UiToolName, boolean>>}?` | can only NARROW the advertised `devia-ui` tools |
| `worktreePerSession` | `boolean`, `false` | DEPRECATED, gates nothing (isolation is mandatory for additional panes) |
| `worktreeBaseRef` | `'default-branch' \| 'current'`, `'default-branch'` | ref a session worktree branches from |

## Other config-like inputs

- `~/.devia-app/state.json`: runtime flags and pinned projects.
- `~/.devia-app/agent-defs.json`: user-defined agents (id, bin, `streamFormat: 'acp-json-rpc'`, `acp` block); see [../features/agents.md](../features/agents.md).
- Environment: `DEVIA_PLAN` (placeholder plan gate), `DEVIA_LOG_RAW_CLI=1` (raw CLI logs), `DEVIA_ASSUME_ENTERPRISE_MCP=1|0`, `DEVIA_SAAS_URL` (upgrade link), `ANTHROPIC_API_KEY` (auxiliary summariser), `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `ENGRAM_DATA_DIR`, `CODEGRAPH_ORACLE_BIN` (tests only).
- Per-project: `<project>/.devia/` ([persistence-layout.md](../architecture/persistence-layout.md)), code-graph `project.json` toggles.

## Related

- [../features/workspace.md](../features/workspace.md), [../features/settings.md](../features/settings.md)
