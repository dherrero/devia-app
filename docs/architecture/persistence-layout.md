# Persistence layout

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

`deviaDir` is `~/.devia-app/` (`ConfigRepository.deviaDir()`, `src/main/shared/ports/config-repository.port.ts`; folder name `.devia-app` in `src/main/features/workspace/infrastructure/fs-config-repository.ts`). The audit log is the exception: it lives in Electron's `userData` folder.

| Path | Content | Owner |
| --- | --- | --- |
| `devia-app.config.json` | `DeviaConfig` (secrets such as the Telegram token sealed) | [workspace](../features/workspace.md) |
| `state.json` | runtime flags (`newSession` per project, pinned projects, toggles, per-project `preferredAgentId`) | workspace / [pinned-projects](../features/pinned-projects.md) |
| `window-state.json` | last window bounds + maximized flag (`src/main/shell/window-state.ts`) | shell |
| `bases.json` | "new from base" templates | [workspace](../features/workspace.md) |
| `agent-defs.json` | user-defined agents (incl. ACP) | [cli-adapters](../features/cli-adapters.md) |
| `sessions/<project>/session-<uuid>.json` | chat history, stats, run mode, workdir | [sessions](../features/sessions.md) |
| `projects/<key>/` | per-project data: session index, `kanban.json`, `memory.json`, `ui-confirmations.json` | sessions, [sdd](../features/sdd.md), [memory](../features/memory.md), [ui-tools](../features/ui-tools.md) |
| `memory-global.json` | personal-scope memory | [memory](../features/memory.md) |
| `queues.json` | per-session instruction queues | [queue](../features/queue.md) |
| `mcp-servers.json` | configured MCP servers (global); project scope is `<project>/.devia/mcp-servers.json` | [mcp](../features/mcp.md) |
| `skills/<key>/<name>/` | cached skill copies shared by every project | [skills](../features/skills.md) |
| `prompt-packs/<id>/PACK.md` | user prompt packs | [prompt-packs](../features/prompt-packs.md) |
| `kits/devia-method/<tag>-<hash>/` | materialised Devia Method kit (read-only files) | [starter-kits](../features/starter-kits.md) |
| `snapshots/<feature>/<id>/` | gzip snapshots before destructive config writes | [snapshot](../features/snapshot.md) |
| `attachments/` | files attached in the composer / Telegram | [attachments](../features/attachments.md) |
| `outbox-archive/` | files the agent dropped in `outbox/` | [outbox](../features/outbox.md) |
| `worktrees/<projectKey>/<sessionId>/` | git worktrees of additional split panes | [split-view](../features/split-view.md) |
| `code-graph/<projectKey>/` | `graph.db`, `project.json`, `writer.lock`, `tool-usage.jsonl` | [code-graph](../features/code-graph.md) |
| `tmp/` | per-run configs (`mcp-<uuid>.json`, `code-mode/<runId>/`, pi extension, Gemini policy), owner-only, removed after the run, swept at startup (24 h TTL) | [claude-runner](../features/claude-runner.md) |
| `logs/agent-cli/<agentId>/` | raw CLI stdout/stderr JSONL, only when `IS_DEV` or `DEVIA_LOG_RAW_CLI=1` (size-capped, 7-day purge) | [cli-adapters](../features/cli-adapters.md) |
| `<userData>/audit.log` (+ rotated files) | audit trail of tool calls (JSONL) | [security](../features/security.md) |

Outside `deviaDir`:

- `<project>/.devia/` — `sub-agents/` ([sub-agents](../features/sub-agents.md)), `skill-registry.md` ([skill-registry](../features/skill-registry.md)), `review/` (review packages, self-ignoring), project-scope `mcp-servers.json`.
- `os.tmpdir()/devia-ui/<runId>/` — UI-tool rendezvous ([ui-tools](../features/ui-tools.md)).
- Agent-native config files Devia writes to deliver MCP/skills/sub-agents: see [../features/mcp.md](../features/mcp.md), [../features/skills.md](../features/skills.md).
- Browser localStorage: theme, style, zoom, pane layout skeleton, first-run prompt flags.

## Rules

- Writes of JSON state are atomic (temp file + rename); state read at a boundary goes through a defensive parser (`parsePersistedSession`, memory parser, config merge).
- Kanban/memory identity uses the BASE checkout, never a session worktree path.
- Nothing is written into the user's repository except `.devia/` content the user manages, `outbox/` (the agent's own), and files the agent itself creates.
- Never rename the npm package (`devia-app`): Electron derives `app.name` and the userData folder from it.

## Related

- [process-and-ipc.md](process-and-ipc.md), [../reference/config.md](../reference/config.md)
