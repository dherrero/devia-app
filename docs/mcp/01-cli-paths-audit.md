# MCP config paths per CLI — audit (T-49)

Audit date: 2026-05-29. Verified against vendor docs via WebFetch
(Playwright-driven). Cross-check before editing `agent-targets.ts` (T-50).

## Summary table

| CLI            | Global path                                       | Project path                              | Key (JSON/TOML)                    | Format | List command                                | Headless trust mechanism                                                                                  |
| -------------- | ------------------------------------------------- | ----------------------------------------- | ---------------------------------- | ------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| claude         | `~/.claude.json` (per-project section inside)     | `<project>/.mcp.json`                     | `mcpServers`                       | JSON   | `claude mcp list`                           | `.claude/settings.local.json` → `enabledMcpjsonServers: [..]` + `permissions.allow: ["mcp__<id>"]`        |
| codex          | `~/.codex/config.toml`                            | `<project>/.codex/config.toml` (trusted) | `[mcp_servers.<name>]` table       | TOML   | `codex mcp list` (also `/mcp` in TUI)       | `approval_policy = "never"` + `sandbox_mode = "danger-full-access"` (or `exec --sandbox danger-full-access`) |
| gemini         | `~/.gemini/settings.json`                         | `<project>/.gemini/settings.json`         | `mcpServers`                       | JSON   | `gemini mcp list`                           | Per-server `"trust": true` (skip confirmations) + `--yolo` + `GEMINI_CLI_TRUST_WORKSPACE=true`            |
| opencode       | `~/.config/opencode/opencode.json`                | `<project>/opencode.json` (project root)  | `mcp`                              | JSON   | `opencode mcp list`                         | Default-permissive `permission` map; runtime flag `--dangerously-skip-permissions` (legacy: `tools` block) |
| cursor-agent   | `~/.cursor/mcp.json`                              | `<project>/.cursor/mcp.json`              | `mcpServers`                       | JSON   | (no `mcp` subcommand) — inspect file/IDE UI | `~/.cursor/permissions.json` (auto-run allowlist) + `--force` / `--yolo` print-mode flags                 |
| copilot        | `~/.copilot/mcp-config.json`                      | (no project file documented for CLI)      | `mcpServers`                       | JSON   | `/mcp show` (interactive only)              | `--allow-all-tools` / `--allow-tool=<spec>` flags, slash `/allow-all` and `/yolo`                          |
| qwen           | `~/.qwen/settings.json`                           | `<project>/.qwen/settings.json`           | `mcpServers`                       | JSON   | `qwen mcp list`                             | Per-server `"trust": true` + `--yolo` (inherited from Gemini CLI fork)                                    |
| pi             | `~/.pi/agent/mcp.json`                            | `<project>/.pi/mcp.json`                  | `mcpServers`                       | JSON   | `pi mcp list`                               | Project config loaded only when project is trusted by Pi's trust manager; global config always loaded      |

Bold mismatches versus current `agent-targets.ts` are listed in
[Devia mismatches found](#devia-mismatches-found).

---

## Per-CLI detail

### 1. Claude Code (`claude`)

- **Source URL**: https://docs.claude.com/en/docs/claude-code/mcp (redirects
  to https://code.claude.com/docs/en/mcp) and
  https://docs.claude.com/en/docs/claude-code/settings.
- **Storage** (from the official scope table on the MCP page):

  | Scope   | Loads in              | Stored in                       |
  | ------- | --------------------- | ------------------------------- |
  | Local   | Current project only  | `~/.claude.json` (per project)  |
  | Project | Current project only  | `.mcp.json` in project root     |
  | User    | All your projects     | `~/.claude.json` (top-level)    |

  And the settings doc explicitly states: "MCP local-scoped servers are
  stored in `~/.claude.json`". `~/.claude/mcp.json` is **not** a path the CLI
  reads.
- **JSON key**: `mcpServers` (both in `.mcp.json` and inside the projects
  block of `~/.claude.json`).
- **List command**: `claude mcp list` (also `claude mcp get <name>` and
  `/mcp` inside the TUI).
- **Headless trust**: Claude Code has no `--yolo`. Auto-approval for MCP is
  the `.claude/settings.local.json` keys:
  - `enableAllProjectMcpServers: true` (approve every server in `.mcp.json`)
  - `enabledMcpjsonServers: ["server1", ...]` (selective approve)
  - `permissions.allow: ["mcp__<server>"]` for full-server tool trust.
  Devia already drives these from `claude-defaults.ts` and uses
  `--mcp-config` to inject runner-only servers (whose trust is implicit).
- **Notes that affect us**: `--strict-mcp-config` exists and excludes
  user/project servers from a session. Plugin MCPs are merged at runtime
  and not in any file we manage.

### 2. OpenAI Codex (`codex`)

- **Source URLs**:
  - https://developers.openai.com/codex/mcp
  - https://developers.openai.com/codex/config-basic
  - https://developers.openai.com/codex/noninteractive
  - https://developers.openai.com/codex/agent-approvals-security
- **Storage**: confirmed by config-basic page — "Personal defaults live in
  `~/.codex/config.toml`, project overrides in `.codex/config.toml`
  (trusted projects only)".
- **TOML key**: each server is a `[mcp_servers.<server-name>]` table.
  Plugin-bundled servers use `[plugins."<id>".mcp_servers.<server>]`
  instead. Top-level `mcp_oauth_callback_port` / `_url` sit alongside.
- **List command**: `codex mcp` (parent), `codex mcp list`,
  `codex mcp --help`. TUI slash: `/mcp`.
- **Headless trust**:
  - Sandbox modes: `read-only` | `workspace-write` |
    `danger-full-access`. Bypass everything with `--sandbox
    danger-full-access`.
  - Approval modes: `untrusted`, `on-request`, `on-failure`, `never`. Set
    `approval_policy = "never"` in `config.toml` or `--ask-for-approval
    never` on the CLI.
  - `codex exec --full-auto` is deprecated; the docs recommend explicit
    `--sandbox workspace-write` (or `danger-full-access`) plus
    `--ask-for-approval never`.
  - MCP tool calls with `destructive` annotations always require approval
    regardless of mode (per the agent-approvals page).
- **Notes**: `--ignore-user-config` skips `$CODEX_HOME/config.toml`
  entirely; useful to test isolated configs but Devia doesn't use it.

### 3. Gemini CLI (`gemini`)

- **Source URLs**:
  - https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
  - https://geminicli.com/docs/cli/trusted-folders/
- **Storage** (from the `gemini mcp add` doc): "Based on the scope
  (`-s, --scope`), it will be added to either the user config
  `~/.gemini/settings.json` or the project config `.gemini/settings.json`
  file."
- **JSON key**: top-level `mcpServers`. Also `mcp` (sibling key) for
  global `serverCommand`, `allowed`, `excluded` list filters.
- **Per-server options that matter for us**: `trust: boolean` — when
  `true`, bypasses every tool-call confirmation for that server (default
  `false`). Plus `includeTools`/`excludeTools`.
- **List command**: `gemini mcp list`. (`gemini mcp add/remove/list` are
  the documented subcommands.)
- **Headless trust**:
  - Per-server `"trust": true` in `mcpServers`.
  - CLI flag `--yolo` accepts all tool calls in the session.
  - Folder Trust gate: when enabled, an untrusted folder makes the CLI
    **refuse to connect to MCP servers at all**. Bypass with `--skip-trust`
    or env `GEMINI_CLI_TRUST_WORKSPACE=true` (Devia already sets this).
  - Trust file: `~/.gemini/trustedFolders.json` (override via
    `GEMINI_CLI_TRUSTED_FOLDERS_PATH`).

### 4. OpenCode (`opencode`)

- **Source URLs**:
  - https://opencode.ai/docs/mcp-servers/ (correct slug; `/docs/mcp/`
    returns 404)
  - https://opencode.ai/docs/config/
  - https://opencode.ai/docs/permissions/
- **Storage** (from the config page): "Global config: `~/.config/opencode/
  opencode.json`. Project config: `opencode.json` in the project root"
  (no `.opencode/` directory for the config file itself — the `.opencode/`
  directory holds agents/commands/plugins/skills).
- **JSON key**: `mcp` (not `mcpServers`). Each entry has `type: "local"
  | "remote"`, `command` (array), `url`, `headers`, `env(ironment)`,
  `enabled`, `timeout`, `oauth`.
- **List command**: `opencode mcp list` (per docs); also `opencode mcp
  auth <server>`, `opencode mcp logout <server>`, `opencode mcp debug
  <server>`.
- **Headless trust**:
  - Default `permission` map is permissive (`*` resolves to `allow`).
  - Devia already passes `--dangerously-skip-permissions` to the runner
    for full auto-approval. There's no per-MCP trust flag — once the
    server is enabled in `mcp` and the permission is `allow` (default),
    its tools run without prompting.
  - Tools key (legacy): `"tools": {"my-mcp*": false}` toggles tools by
    name pattern. Use `permission` instead in new configs.

### 5. Cursor Agent (`agent` — formerly `cursor-agent`)

- **Source URLs**:
  - https://cursor.com/docs/mcp
  - https://cursor.com/docs/cli/installation
  - https://cursor.com/docs/cli/using
  - https://cursor.com/docs/cli/headless
- **CLI binary name**: `agent` (the installer puts it in
  `~/.local/bin/agent`). The "cursor-agent" historical name still works
  on older installs but the docs only mention `agent` now.
- **Storage** (verbatim from the MCP docs):
  - Project: `.cursor/mcp.json`
  - Global: `~/.cursor/mcp.json`
- **JSON key**: `mcpServers`. Each entry can carry `type` (`stdio` only;
  remote uses `url`), `command`, `args`, `env`, `envFile` (stdio only),
  `headers`, `auth` (static OAuth credentials).
- **List command**: **none documented**. The CLI docs say "agente is
  compatible with MCP and will automatically detect and respect your
  `mcp.json` file". There is no `agent mcp list`/`agent mcp add`
  subcommand in the documented CLI surface. To inspect what's loaded
  users either read the file or open the Cursor editor's MCP UI.
- **Headless trust**:
  - Print mode `agent -p` won't apply changes; combine with `--force` or
    the alias `--yolo` to allow edits/tool calls without prompts.
  - **Per-MCP-tool auto-run allowlist** lives in
    `~/.cursor/permissions.json` (per MCP docs: "Para preconfigurar qué
    herramientas de MCP pueden ejecutarse automáticamente sin usar la
    interfaz de usuario de ajustes, añádelas a `~/.cursor/permissions.json`").
  - Sandbox toggle: `/sandbox` or `--sandbox <enabled|disabled>`.

### 6. GitHub Copilot CLI (`copilot`)

- **Source URLs**:
  - https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
    (the canonical landing
    `https://docs.github.com/en/copilot/customizing-copilot/mcp` returns
    404; reached via search).
  - https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli
  - https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp
    (this is the **VS Code** flow, which uses different paths/keys.)
- **CLI binary name**: `copilot` (NOT `gh copilot` — `gh copilot` is the
  older `gh` extension with chat/suggest only and no MCP).
- **Storage** (verbatim): "You can also add MCP servers by editing the
  configuration file at `~/.copilot/mcp-config.json`." There is **no
  documented project-level config file for the CLI**. Devia currently
  writes `.vscode/mcp.json` for the project scope; that file is the
  **VS Code extension's** config, not the CLI's — and even VS Code uses a
  different JSON key (`servers`, not `mcpServers`).
- **JSON key**: `mcpServers` (for the CLI's `~/.copilot/mcp-config.json`).
  Each entry has `type` (`local` | `http` | `sse`), `command`, `args`,
  `env`, `url`, `headers`, `tools` (array of tool names or `["*"]`).
- **List command**: `/mcp show` (interactive slash command only). Also
  `/mcp show <name>`, `/mcp edit`, `/mcp delete`, `/mcp enable`,
  `/mcp disable`. No documented `copilot mcp list` non-interactive form.
- **Headless trust**:
  - `--allow-all-tools` (every tool incl. MCP runs without prompts).
  - `--allow-tool <spec>` for granular allowlist (e.g.
    `--allow-tool='shell(git)'`).
  - Slash equivalents in interactive: `/allow-all`, `/yolo`.
  - **Known gaps**: org-level "MCP servers in Copilot" policy and "MCP
    Registry URL" policy are documented as **not yet enforced** by the
    CLI.

### 7. Qwen Code (`qwen`)

- **Source URLs**:
  - https://github.com/QwenLM/qwen-code/blob/main/README.md
  - https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/commands/mcp.ts
  - https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/commands/mcp/add.ts
  - https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/config/config.ts
- **Lineage**: Qwen Code is a hard fork of Gemini CLI. The MCP command
  surface (`qwen mcp add/remove/list/reconnect`) and settings schema
  mirror Gemini CLI 1:1.
- **Storage**: User config: `~/.qwen/settings.json` (confirmed in
  README). Project config: `<project>/.qwen/settings.json` — derived
  from the gemini-fork code in `commands/mcp/add.ts`:
  - `scope === 'user'` → `SettingScope.User` → `~/.qwen/settings.json`
  - `scope === 'project'` → `SettingScope.Workspace` →
    `<cwd>/.qwen/settings.json` (refused when `cwd === $HOME`).
- **JSON key**: `mcpServers`. Same shape as Gemini CLI
  (`command`/`args`/`env`/`url`/`httpUrl`/`headers`/`trust`/`timeout`/
  `includeTools`/`excludeTools`/`oauth`).
- **List command**: `qwen mcp list`. Also `add/remove/reconnect`.
- **Headless trust**: same Gemini lineage — per-server `"trust": true`,
  CLI flag `--yolo`, plus the approval-mode enum (`plan`, `default`,
  `auto-edit`, `auto`, `yolo`) configurable via `--approval-mode`.

### 8. Pi (`pi`)

- **Source URL**: https://withpi.ai (Pi Coding Agent by Earendil Works)
- **Storage** (from `pi-coding-agent` source):
  - Global: `~/.pi/agent/mcp.json` — read by the MCP extension on every
    session start.
  - Project: `<project>/.pi/mcp.json` — read only when the project is
    **trusted** by Pi's `ProjectTrustStore` (`~/.pi/agent/trust.json`).
    Untrusted projects silently ignore the project-scoped file.
- **JSON key**: `mcpServers`. Standard object map where each entry is an
  `McpStdioServerConfig` or `McpHttpServerConfig` with Pi-specific fields:
  - `command`, `args`, `env` (stdio)
  - `url`, `headers`, `oauth` (streamable HTTP)
  - `exposure`: `codemode` | `deferred` | `direct` | `hidden` — how tools
    are surfaced to the model (Pi-specific).
  - `toolExposure`: per-tool override map.
  - `enabled`, `timeout`, `description`.
- **List command**: `pi mcp list` (also `add`, `remove`, `login`, `logout`).
- **Headless trust**: No interactive trust prompt in `--mode rpc`. Devia
  writes the config file and Pi loads it on the next session start. The
  trust decision is stored in `~/.pi/agent/trust.json` and managed by
  Pi's built-in trust manager.
- **Devia delivery**: Pi has no `--mcp-config` flag, and the project file is
  ignored in untrusted folders (every session worktree), so Devia's bundled
  servers are NOT written there. The runner passes a per-run extension
  (`-e <deviaDir>/tmp/pi-mcp-<uuid>.mjs`) that calls `pi.registerMcpServer()`
  — loaded regardless of trust, nothing persisted. Devia-managed entries left
  in `<project>/.pi/mcp.json` by older versions are stripped on every pi run
  (a file entry overrides a registration with the same name). User-managed
  servers keep going to the native files through `McpSyncWriter`.
- **Tool names**: `mcp__<server>__<tool>`, server sanitised to `[A-Za-z0-9_]`.

---

## Devia mismatches found

Listed by current code (`src/main/features/mcp/domain/agent-targets.ts`):

1. **claude / global** — **needs-fix**. Code writes
   `~/.claude/mcp.json`; the documented user-scope file is `~/.claude.json`
   (with servers under `projects[<cwd>].mcpServers` for local scope, or a
   top-level `mcpServers` for user scope). Writing to `~/.claude/mcp.json`
   has no effect: Claude Code never reads that path.
   - Risk: medium. Devia already uses `--mcp-config` for the global servers
     it cares about, so the unread file isn't blocking anything today. But
     anyone expecting `claude mcp list` to show Devia's entries will see
     them missing, and a user who runs `claude` outside Devia loses
     access. Recommended replacement: write to
     `~/.claude.json` → `mcpServers` (user scope) with a merge that
     preserves the surrounding `projects` map.

2. **claude / project** — **confirmed**. `<project>/.mcp.json` with key
   `mcpServers` matches the docs verbatim.

3. **codex / global** — **confirmed**. `~/.codex/config.toml` with
   `[mcp_servers.<name>]`. (Devia uses `toml-merge` and doesn't pin a
   `jsonParentKey`; this is correct because the section name varies per
   server.)

4. **codex / project** — **confirmed**. `<project>/.codex/config.toml`
   matches docs (only loaded for trusted projects).

5. **gemini / global** — **confirmed**. `~/.gemini/settings.json`,
   `mcpServers`.

6. **gemini / project** — **confirmed**. `<project>/.gemini/settings.json`,
   `mcpServers`.

7. **opencode / global** — **confirmed**.
   `~/.config/opencode/opencode.json`, key `mcp`.

8. **opencode / project** — **needs-fix**. Code writes
   `<project>/.opencode/opencode.json`. Per the official OpenCode config
   docs the project config is `<project>/opencode.json` (at the project
   root), **not** inside the `.opencode/` directory. The `.opencode/`
   folder is for agents/commands/plugins/skills only. Writing to
   `.opencode/opencode.json` is silently ignored by `opencode`.

9. **cursor-agent / global** — **confirmed**. `~/.cursor/mcp.json`,
   `mcpServers`. (Binary name now `agent`, but the file is shared with the
   Cursor editor.)

10. **cursor-agent / project** — **confirmed**.
    `<project>/.cursor/mcp.json`, `mcpServers`.

11. **copilot / global** — **needs-fix**. Code writes
    `~/.copilot/mcp.json`. The Copilot CLI docs explicitly name
    `~/.copilot/mcp-config.json`. `mcp.json` is not read by `copilot`.

12. **copilot / project** — **unclear / needs-fix**. Code writes
    `<project>/.vscode/mcp.json`, but:
    - That file is for the **VS Code Copilot Chat extension**, not the
      `copilot` CLI.
    - Even VS Code uses key `servers` (not `mcpServers`) in
      `.vscode/mcp.json`, so the file we write wouldn't be valid for VS
      Code either.
    - The `copilot` CLI has **no documented project-scoped MCP file**.
    Recommendation: drop project scope for the `copilot` agent (return
    `null` from `resolveAgentTarget`) until GitHub documents one, OR keep
    writing `.vscode/mcp.json` but with key `servers` and an explicit
    note that this only helps the IDE, not the CLI.

13. **qwen / global** — **confirmed**. `~/.qwen/settings.json`,
    `mcpServers`.

14. **qwen / project** — **confirmed**.
    `<project>/.qwen/settings.json`, `mcpServers`.

---

## Open questions

- **Copilot CLI project-scope file**. The CLI docs only describe
  `~/.copilot/mcp-config.json`. There's no published per-project path.
  Either GitHub hasn't shipped one or it's undocumented. T-50 should
  either (a) remove project scope for `copilot` or (b) write the VS Code
  file with the correct `servers` key and a comment explaining it is
  IDE-only. Needs a manual probe of `copilot --help` + `/mcp add` on a
  fresh install to confirm there's no hidden project path.

- **Cursor `agent mcp list`**. The CLI docs don't list any `agent mcp`
  subcommand. The `mcp.json` files are still the source of truth (shared
  with the Cursor editor), but there's no documented terminal command
  to enumerate what the CLI loaded. Needs `agent --help` on a live
  install to confirm. Until then, treat "list command" as N/A for
  Cursor.

- **Claude user-scope projects map**. `~/.claude.json` mixes user data
  (auth, telemetry, projects map) with per-project local-scope MCP entries.
  Writing into it requires the **same merge contract Claude Code uses
  itself** to avoid clobbering unrelated keys. Before T-50 implements the
  fix, decide whether to (a) write user-scope MCP via `claude mcp add
  --scope user --transport ...` invocations (no file munging) or (b)
  surgically upsert `mcpServers` only. Option (a) is safer.

- **OpenCode `.opencode/opencode.json` legacy?** Some older OpenCode
  releases reportedly read both `opencode.json` and `.opencode/opencode.json`.
  The current docs only mention `opencode.json` at the project root.
  Before T-50, check the installed `opencode` version's source to see
  whether the legacy fallback still exists; otherwise our writes have
  been silently ignored in production.

- **Codex managed configs**. The docs reference an enterprise
  `requirements.toml` layer (`/etc/codex/requirements.toml` or similar)
  that can override `approval_policy`/`sandbox_mode`. Not relevant for
  per-user Devia installs, but worth noting if Devia is ever deployed in
  an enterprise context — admin requirements may refuse the
  `danger-full-access` Devia configures.

- **Copilot org-level MCP policies**. Two policies ("MCP servers in
  Copilot" toggle and "MCP Registry URL") are documented as **not yet
  enforced by the CLI**. Headless installs in an enterprise org may have
  MCP silently disabled from the server side once GitHub ships
  enforcement; Devia should surface "MCP unavailable per org policy" as
  a status when the CLI begins respecting these.
