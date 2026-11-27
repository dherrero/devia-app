# Capabilities matrix

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823 (app 0.39.0)

One row per capability: does Devia do it? Status: `implemented`, `partial`, `not implemented`. Every `not implemented` row was checked by searching `src/` (what was searched is in Notes). Use this page to compare Devia with other tools, then follow the link for detail.

## Agents and runs

| Capability | Status | Page | Notes |
| --- | --- | --- | --- |
| Drive CLI coding agents headlessly from one window | implemented | [cli-adapters](features/cli-adapters.md) | 13 agent defs: claude, codex, gemini, opencode, cursor-agent, copilot, grok, pi, kimi, hermes, qwen, qoder, deepseek |
| Explain agent failures (what happened, why, what to do) | implemented (Claude, PI, OpenCode checked against real shapes; the other agents unverified live) | [cli-adapters](features/cli-adapters.md) | Error card with actions in the chat; plain text on Telegram; es/en |
| Agent per project and per session (session > project > global) | implemented | [cli-adapters](features/cli-adapters.md) | `src/main/shared/effective-agent-resolver.ts`; the footer picks the project/session agent, Settings the default; no per-project model/effort/env |
| Per-agent mappers behind a stable port | partial | [agents](features/agents.md) | dedicated: claude, pi, opencode; ACP: kimi, hermes + user-defined; the other 8 run on `LegacyMapper` |
| Agent Client Protocol (ACP) agents | implemented | [agents](features/agents.md) | SDK pinned 1.9.0; no `fs`/`terminal` served; kimi profile unverified |
| User-defined agents | partial | [agents](features/agents.md) | ACP only (`agent-defs.json`) |
| plan / apply / apply-yolo modes persisted per session | implemented | [run-modes](features/run-modes.md) | enforcement differs per agent; Codex plan relies on prompt discipline |
| Resume a session automatically after a usage limit | implemented | [auto-continue](features/auto-continue.md) | Claude Code only; memory-only (lost if the app closes) |
| Context %, cost, tokens, compactions per session | implemented | [session-stats](features/session-stats.md) | local only |
| Plan-usage windows (5 h / weekly) and usage tracking per provider | not implemented | [session-stats](features/session-stats.md) | searched `src` for usage-API calls, `five_hour`, weekly windows: only the rate-limit decoder exists |
| Switching between several accounts of one agent | not implemented | [settings](features/settings.md) | searched `src` for account switch / multi-account: none |
| Automatic compression of long histories | not implemented | [context-compression](features/context-compression.md) | `compress` exists but no run calls it |
| Re-inject memory after the agent compacted itself | partial | [context-recovery](features/context-recovery.md) | Claude and pi only |
| Parallel multi-agent orchestration (coordinator spawning supervised workers) | not implemented | [sdd](features/sdd.md) | searched `src` for `spawn_agent`: none (S-26 blocked); only Claude's native sub-agents are shown in chat |
| Sub-agent cards in the chat | partial | [agents](features/agents.md) | Claude only |
| Instruction queue (per project/session, reorder, pause) | implemented | [queue](features/queue.md) | |
| Scheduled / triggered automations (cron, webhooks, PR events) | not implemented | [auto-continue](features/auto-continue.md) | searched `src` for cron, schedule libraries, webhook: none beyond auto-resume |

## Sessions and workspace

| Capability | Status | Page | Notes |
| --- | --- | --- | --- |
| Persistent chat history per project | implemented | [sessions](features/sessions.md) | |
| Import existing CLI sessions | partial | [session-import](features/session-import.md) | Claude, Codex, Grok |
| Cross-agent handoff with context brief | implemented | [session-handoff](features/session-handoff.md) | LLM summary needs Claude + `ANTHROPIC_API_KEY` |
| Split view, up to 4 panes with isolated git worktrees | implemented | [split-view](features/split-view.md) | |
| Worktree setup scripts, copying `.env`, shared dependency dirs | not implemented | [split-view](features/split-view.md) | searched `src` for setup/archive hooks and `.worktreeinclude`: none; `worktree-hooks.ts` only notifies internal lifecycle listeners (`notifyWorktreeHook`) |
| Project listing, new from template, clone, trash, move | implemented | [workspace](features/workspace.md), [clone](features/clone.md) | |
| Attachments of any file type | implemented | [attachments](features/attachments.md) | 50 MB per file, 200 MB per send |
| Files emitted by the agent (`outbox/`) | implemented | [outbox](features/outbox.md) | |
| Local voice dictation | partial | [voice](features/voice.md) | language fixed to `es`; dependency is a devDependency (packaged behaviour unverified) |
| Config snapshots with restore | partial | [snapshot](features/snapshot.md) | only MCP, skills and sub-agents writes are snapshotted |
| 11 UI languages | partial | [i18n](reference/i18n.md) | only `en`/`es` complete; others ~73 %; raw keys shown for gaps |

## Git and review

| Capability | Status | Page | Notes |
| --- | --- | --- | --- |
| Git status, inline diff, branch switcher, ff-only pull | implemented | [git](features/git.md) | |
| Line-level review comments sent back to the agent | implemented | [chat-ui](features/chat-ui.md) | `revisa:` prompt |
| Create commits / push / open PRs, CI checks, auto-merge | not implemented | [git](features/git.md) | searched `src` for octokit, pull request, `gh pr`: none; agents do it with their own tools |
| Issue trackers as task sources (GitHub, GitLab, Linear, Jira) | not implemented | [sdd](features/sdd.md) | searched `src` for gitlab/jira/linear: only unrelated matches |
| AI-generated commit messages / PR descriptions, "fix failing checks" | not implemented | [git](features/git.md) | no UI action |
| Attribution of AI vs human lines | not implemented | [chat-ui](features/chat-ui.md) | searched `src`: none |
| Built-in file editor | not implemented | [project-tree](features/project-tree.md) | tree is read-only; no editor library in `package.json` (monaco/codemirror absent); files open via the OS or an IDE ([shell](features/shell.md)) |
| Open in IDE (10 IDEs) | implemented | [shell](features/shell.md) | |
| Integrated terminal per project | implemented | [terminal](features/terminal.md) | hidden in split view |
| Docker Compose panel | implemented | [docker-compose](features/docker-compose.md) | |

## Harness, memory and method

| Capability | Status | Page | Notes |
| --- | --- | --- | --- |
| MCP manager delivering servers to 9 agents' native configs | implemented | [mcp](features/mcp.md) | 8-entry catalog; kimi/hermes via ACP; qoder/deepseek none |
| Interactive cards for any agent (questions, plan approval, review, confirm, pick) | implemented | [ui-tools](features/ui-tools.md) | desktop only; withheld on Telegram |
| Persistent memory (`devia-memory`) with optional semantic re-rank | implemented | [memory](features/memory.md) | |
| Spec/task kanban driven by the agent (`devia-kanban`) | implemented | [sdd](features/sdd.md) | 13 tools |
| Skills manager across agents | implemented | [skills](features/skills.md), [skill-registry](features/skill-registry.md) | |
| Sub-agent definitions synced to CLIs | implemented | [sub-agents](features/sub-agents.md) | |
| Prompt packs | partial | [prompt-packs](features/prompt-packs.md) | scanner and compose exist; no UI, no built-in packs, never selected in a run |
| Built-in development method (Devia Method) | implemented | [starter-kits](features/starter-kits.md) | |
| Own code graph (6 languages) served over MCP and a `/graph` view | implemented | [code-graph](features/code-graph.md) | |
| Sandboxed TypeScript scripts over MCP servers (code mode) | implemented | [code-mode](features/code-mode.md) | read-only v1 |
| Plugin / extension system for third-party panels, themes or workers | not implemented | [settings](features/settings.md) | searched `src` for a plugin manifest/host API: none (the kit's `.claude-plugin` is Claude's own plugin format) |
| Computer use (drive desktop apps), mobile emulators | not implemented | [mcp](features/mcp.md) | searched `src` for accessibility tree, computer use, simulator/emulator: none; Playwright MCP is only a catalog entry |
| Embedded browser / design-mode element picker | not implemented | [chat-ui](features/chat-ui.md) | searched `src` for webview, BrowserView, WebContentsView: none |

## Remote and platform

| Capability | Status | Page | Notes |
| --- | --- | --- | --- |
| Remote control through Telegram, with file relay | implemented | [telegram-controller](features/telegram-controller.md) | only while Devia is open; one authorised chat |
| Other chat platforms (Slack, Discord) | not implemented | [telegram-controller](features/telegram-controller.md) | config namespace is shaped for it; nothing else exists |
| Native mobile app | not implemented | [telegram-controller](features/telegram-controller.md) | no mobile project in the repository; Telegram is the phone surface |
| Remote runtime: SSH hosts, headless server, cloud VMs | not implemented | [process-and-ipc](architecture/process-and-ipc.md) | searched `src` for ssh clients and a server mode: none; everything runs on the local machine |
| Agent hibernation / background idle management | not implemented | [claude-runner](features/claude-runner.md) | not applicable: runs are headless per turn, no persistent PTY per agent |
| Auto-update of installed builds | implemented | [auto-update](features/auto-update.md) | not on unpackaged builds or Linux `.deb` |
| Audit log of tool calls | implemented | [security](features/security.md) | stored in Electron userData |
| Default-deny environment for agent processes, SSRF guard | not implemented | [security](features/security.md) | the primitives exist (`env-slicer`, `ssrf-validator`) but are not wired |
| Platforms | implemented | [build-and-distribution](architecture/build-and-distribution.md) | macOS, Windows (nsis x64), Linux (AppImage, deb x64) |

## Related

- [README.md](README.md), [CONVENTIONS.md](CONVENTIONS.md)
