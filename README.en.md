# Devia

**Devia** is an **open-source** desktop app (Windows, macOS and Linux) for working with CLI coding agents — Claude Code, Codex, Gemini CLI, OpenCode, Pi and more — from a single window, with no terminal and no cloud.

[Español](README.md) · [Downloads](https://dherrero.github.io/devia/en/descargas/) · [Docs](https://dherrero.github.io/devia/en/docs/) · [Releases](https://github.com/dherrero/devia/releases)

## What you get

- Streaming chat, diff viewer and per-line comments with "Send for review".
- Split view with up to 4 agents in parallel, isolated in git worktrees.
- Built-in spec-driven kanban, persistent memory and an MCP server manager.
- Telegram remote control, local voice transcription, terminal and branch switcher.
- Everything runs locally, on top of your projects and your CLIs.

## Install

Download the installer from the [downloads page](https://dherrero.github.io/devia/en/descargas/). The app updates itself from the [Releases](https://github.com/dherrero/devia/releases).

## Development

```bash
nvm use && npm install
npm run build:desktop && npm run dev:desktop
```

| Path | What |
| --- | --- |
| [`apps/desktop`](apps/desktop) | The app: Electron main process + Angular 21 renderer |
| [`libs/ui`](libs/ui), [`libs/styles`](libs/styles) | Shared components and design tokens |

Guides: [CONTRIBUTING.md](CONTRIBUTING.md) · [AGENTS.md](AGENTS.md) · [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md) · [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) · © 2024-2026 Daniel Herrero Tomás and Ruben Sanz Rosa. See [NOTICE](NOTICE).
