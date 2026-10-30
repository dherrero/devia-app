# `devia-ui` cross-agent verification matrix (S-25 F4.1)

**Status: NOT RUN.** This is the procedure and the empty grid. Filling it needs
each CLI actually installed and authenticated, which is why it is manual by
design — a headless run cannot produce this evidence about itself.

The whole value of S-25 is that it works with **every** agent, not just Claude.
Until this table is green, S-25 F4.2 (deleting `devia-ask`) stays blocked: do
not remove the fallback before confirming the replacement lands.

## Procedure, per agent

1. Select the agent in Devia and open a project that is a git repo.
2. **Build first, then start** — `npm run build && npm run dev`.
   The main process does not hot-reload and `dev` races itself.
3. Turn on raw stream capture: `DEVIA_LOG_RAW_CLI=1`. Logs land in
   `~/.devia-app/logs/agent-cli/<agentId>/`.
4. Send any instruction in **apply** mode, then check, in order:

| # | Check | Where to look |
| --- | --- | --- |
| 1 | Server delivered | Claude: `mcp__devia-ui` in `.claude/settings.local.json`. Others: a `devia-ui` entry in the agent's native MCP config |
| 2 | `tools/list` reached the model | the raw stdout log — the tool names must appear in the request/init payload |
| 3 | A fire-and-forget tool works | ask for `devia_todo`; the card must appear and the call must return at once |
| 4 | A blocking tool works | ask for `devia_confirm`; the card must appear and the agent must resume with the answer |
| 5 | No interactive permission prompt | the run must not stall waiting for approval |
| 6 | `devia-ask` retired | the old entry is gone from the native config |

## Matrix

| Agent | 1 delivered | 2 tools/list | 3 fire&forget | 4 blocking | 5 auto-approve | 6 ask retired | CLI version | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | | | | | | | | grant lives in `.claude/settings.local.json`, NOT in a per-run `--allowedTools` |
| codex | | | | | | | | TOML writer; `startupTimeoutSec` + `defaultToolsApprovalMode` are its fields |
| gemini | | | | | | | | |
| opencode | | | | | | | | `opencode-local` entry shape (`command` is the whole argv array) |
| cursor-agent | | | | | | | | **no yolo flag; headless trust UNVERIFIED** |
| copilot | | | | | | | | **no yolo flag; headless trust UNVERIFIED** |
| grok | | | | | | | | reads MCP only from the GLOBAL `~/.grok/user-settings.json`, nested `mcp.servers[]` array |
| qwen | | | | | | | | |

Out of scope by design: `deepseek`, `qoder`, `mimo` — no MCP config target, so
`UiMcpInjector.supports()` is false and they get the plain-text fallback.

## Enterprise MCP carve-out

Run once with `DEVIA_ASSUME_ENTERPRISE_MCP=1`: Devia must pass **neither**
`--mcp-config` nor `--strict-mcp-config`, the run must start, and the prompt
must carry the plain-text fallback instead of any tool announcement.

## Rules for closing this task

- A red cell opens its own follow-up task. It is not "documented and moved on".
- **No cell may be left "not tested".** If an agent cannot be verified (not
  installed, no credentials), say so explicitly and remove it from
  `UiMcpInjector.supports()` rather than shipping a promise that silently fails.
