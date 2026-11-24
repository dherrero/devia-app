# Terminal

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

A real PTY shell per project in the right rail.

## Does

- `PtyManager` (`src/main/features/terminal/infrastructure/pty-manager.ts`) keeps ONE `node-pty` per project; it survives the renderer hiding the panel or switching projects, and ends only when the user stops it or the shell exits, so each project keeps its scrollback and cwd.
- Renderer uses `xterm.js` (`src/renderer/app/features/chat/terminal/`); `Mod+J` toggles it.

## Does NOT

- Does NOT run per split pane: the terminal belongs to the base project, so the right-rail Terminal tab and `Mod+J` are hidden while split view is active.
- Does NOT persist scrollback across app restarts.

## Entry points

- `src/main/features/terminal/index.ts:buildTerminalFeature` — wiring
- `src/main/features/terminal/infrastructure/pty-manager.ts:PtyManager`
- `src/main/features/terminal/ipc/terminal.ipc.ts`
- `src/renderer/app/features/chat/terminal/` — xterm UI

## IPC / MCP surface

- `terminal:start`, `terminal:write`, `terminal:resize`, `terminal:stop`, `terminal:data`, `terminal:exit`.

## Persistence

None.

## Config

None.

## Gotchas

- `node-pty` is a runtime dependency rebuilt for the Electron ABI by `scripts/rebuild-native.cjs` (postinstall).

## Tests

`src/main/features/terminal/**/*.test.ts` where present.

## Related

[split-view.md](split-view.md), [chat-ui.md](chat-ui.md)
