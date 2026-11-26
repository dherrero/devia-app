# Devia — internal documentation

Source of truth for what Devia does and does NOT do. Written in English for AI agents (and the humans who direct them). Code wins over this folder when they disagree: fix the page in the same change.

Verified against `dev` @ `b08bff62130756f1e2eb66ac2578efbef65c2823` (app version 0.39.0), 2026-11-24.

## How to read this folder

1. Start at [capabilities.md](capabilities.md) for the one-table answer to "does Devia do X?".
2. Open the feature page it links to (`features/<name>.md`). Every page has the same sections; see [features/_template.md](features/_template.md).
3. Cross-cutting design lives in [architecture/](architecture/) and data/lookup tables in [reference/](reference/).
4. Writing rules: [CONVENTIONS.md](CONVENTIONS.md). Repo workflow and code conventions: [../AGENTS.md](../AGENTS.md).

## Maintenance rule (binding)

Any new feature, or any change to an existing one, updates in the SAME PR: its `features/<name>.md` page, its row in `capabilities.md`, and this index. A new folder under `src/main/features/` needs its own page (`tools/docs-parity.test.ts` enforces it).

## Index

Status values: `implemented`, `partial`, `deprecated`. Group = the area it belongs to.

### Agent runtime

| Page | One-line purpose |
| --- | --- |
| [features/claude-runner.md](features/claude-runner.md) | Agent-agnostic core of a run: plan, prompt composition, lifecycle, user interaction |
| [features/agents.md](features/agents.md) | Per-agent mappers (Claude, Pi, OpenCode, ACP, legacy) behind the `AgentMapper` port |
| [features/cli-adapters.md](features/cli-adapters.md) | Agent definitions, detection, spawn-only launcher, legacy stream parsers |
| [features/run-modes.md](features/run-modes.md) | plan / apply / apply-yolo and how each agent enforces them |
| [features/auto-continue.md](features/auto-continue.md) | Resume a session automatically after a usage limit |
| [features/session-stats.md](features/session-stats.md) | Context %, cost, tokens and compactions per session |
| [features/context-compression.md](features/context-compression.md) | Auxiliary-LLM history compression and handoff summaries |
| [features/context-recovery.md](features/context-recovery.md) | Re-inject memory after the agent compacted its own context |

### Sessions and workspace

| Page | One-line purpose |
| --- | --- |
| [features/workspace.md](features/workspace.md) | Config, project listing, tech detection, new/clone-from-base, trash/move |
| [features/sessions.md](features/sessions.md) | Per-project chat history on disk, switch/adopt/delete |
| [features/session-import.md](features/session-import.md) | Import existing Claude/Codex/Grok sessions |
| [features/session-handoff.md](features/session-handoff.md) | Switching the CLI agent mid-session carries context over |
| [features/split-view.md](features/split-view.md) | Up to 4 panes, each with its own session and git worktree |
| [features/chat-ui.md](features/chat-ui.md) | Chat panel, composer, tool cards, diff review, queue panel |
| [features/queue.md](features/queue.md) | Per-project instruction queue |
| [features/pinned-projects.md](features/pinned-projects.md) | Sidebar pinning |
| [features/clone.md](features/clone.md) | Clone a repo into the workspace |
| [features/project-tree.md](features/project-tree.md) | File tree in the right rail |
| [features/snapshot.md](features/snapshot.md) | Config/file snapshots before destructive operations |
| [features/attachments.md](features/attachments.md) | Composer attachments of any file type |
| [features/outbox.md](features/outbox.md) | Files the agent emits, archived and optionally relayed |
| [features/voice.md](features/voice.md) | Local Whisper dictation |
| [features/settings.md](features/settings.md) | Settings modal sections, themes, language, shell chrome |

### Tools, harness and method

| Page | One-line purpose |
| --- | --- |
| [features/mcp.md](features/mcp.md) | MCP server manager and delivery to every agent |
| [features/ui-tools.md](features/ui-tools.md) | The `devia-ui` server: questions, plan approval, review, files |
| [features/memory.md](features/memory.md) | Devia persistent memory and the `devia-memory` server |
| [features/sdd.md](features/sdd.md) | Kanban board, specs/tasks and the `devia-kanban` server |
| [features/skills.md](features/skills.md) | Skill discovery/install/remove across agents |
| [features/skill-registry.md](features/skill-registry.md) | Per-project skill index file |
| [features/sub-agents.md](features/sub-agents.md) | Reusable sub-agent definitions synced to each CLI |
| [features/prompt-packs.md](features/prompt-packs.md) | Per-project system-prompt packs |
| [features/starter-kits.md](features/starter-kits.md) | The Devia Method kit and its delivery |
| [features/cross-agent.md](features/cross-agent.md) | Workers of other agents for the method loop (S-56, in progress) |
| [features/code-graph.md](features/code-graph.md) | Own code graph, `devia-code-graph` server, `/graph` view |
| [features/code-mode.md](features/code-mode.md) | Sandboxed TypeScript scripts over the user's MCP servers |

### Remote, git and infrastructure

| Page | One-line purpose |
| --- | --- |
| [features/telegram-controller.md](features/telegram-controller.md) | Telegram remote control and file relay |
| [features/git.md](features/git.md) | Git status/diff/branches/pull/worktrees |
| [features/terminal.md](features/terminal.md) | node-pty terminal per project |
| [features/shell.md](features/shell.md) | Open path / reveal / open in IDE |
| [features/docker-compose.md](features/docker-compose.md) | deploy / down / logs per project |
| [features/status.md](features/status.md) | Process/state telemetry for the status bar |
| [features/security.md](features/security.md) | Audit log, env slicing, SSRF/boundary guards, secrets |
| [features/auto-update.md](features/auto-update.md) | electron-updater wiring |

### Architecture and reference

| Page | One-line purpose |
| --- | --- |
| [architecture/process-and-ipc.md](architecture/process-and-ipc.md) | Process model, bridge, IPC conventions |
| [architecture/agent-layers.md](architecture/agent-layers.md) | render ↔ core ↔ mappers ↔ CLI |
| [architecture/persistence-layout.md](architecture/persistence-layout.md) | Everything under `~/.devia-app/` |
| [architecture/security-guards.md](architecture/security-guards.md) | Security guards that must not be reverted |
| [architecture/build-and-distribution.md](architecture/build-and-distribution.md) | Build, packaging, signing, CI, release, updates |
| [reference/config.md](reference/config.md) | `DeviaConfig` fields |
| [reference/agents-matrix.md](reference/agents-matrix.md) | Every agent: format, prompt strategy, continuity, MCP delivery |
| [reference/mcp-servers.md](reference/mcp-servers.md) | Devia's bundled MCP servers and their tools |
| [reference/i18n.md](reference/i18n.md) | Languages and parity tooling |
| [reference/ipc-channels.md](reference/ipc-channels.md) | IPC channels by prefix |

### Deep dives (history and design records)

| Page | Topic |
| --- | --- |
| [mcp/01-cli-paths-audit.md](mcp/01-cli-paths-audit.md), [mcp/02-scope-decision.md](mcp/02-scope-decision.md) | Where each CLI reads MCP config; scope decision |
| [multisesion/01-session-identity.md](multisesion/01-session-identity.md), [multisesion/02-worktree-lifecycle.md](multisesion/02-worktree-lifecycle.md) | Session identity; worktree lifecycle |
| [ui-tools/00-architecture.md](ui-tools/00-architecture.md), [ui-tools/01-cross-agent-matrix.md](ui-tools/01-cross-agent-matrix.md), [ui-tools/02-context-cost.md](ui-tools/02-context-cost.md), [ui-tools/release-notes.md](ui-tools/release-notes.md) | `devia-ui` design, matrix, cost, notes |
| [devia-method/00-audit.md](devia-method/00-audit.md), [devia-method/01-design.md](devia-method/01-design.md), [devia-method/02-agents.md](devia-method/02-agents.md) | Devia Method audit, design, agent notes |
