# Process model and IPC

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Processes

- **Main** (`src/main/`, TypeScript → CommonJS in `dist/main/main/`; the doubled `main/` is intentional: `dist/main/main/shell/main.js`). Owns agent CLI spawn (`child_process`, `node-pty`), filesystem persistence under `~/.devia-app/`, git, docker, shell exec, MCP server processes.
- **Preload** (`src/main/shell/preload.ts`): exposes `window.devia` through `contextBridge`. The shape is declared in `src/shared/contracts/devia-bridge.ts` and consumed in the renderer through `src/renderer/types/devia.d.ts`. Never add to `window` directly. `BrowserWindow` runs with `contextIsolation: true`, `nodeIntegration: false`, `spellcheck: true`, `backgroundThrottling: false` (`src/main/shell/main.ts`).
- **Renderer** (`src/renderer/`, Angular 21 SPA, standalone components, signals, OnPush): reaches the bridge ONLY through `ElectronApiService` (`src/renderer/app/core/services/electron-api.service.ts`). No NgModules, no RxJS except where Angular needs it.
- **Shared** (`src/shared/`): no Electron imports; `domain/` is plain types and pure functions (no Node APIs); `contracts/` holds `devia-bridge.ts`, `ipc-channels.ts`, `events.ts`.
- **Child processes**: agent CLIs (one per run), `devia-memory`, `devia-kanban`, `devia-ui`, `devia-code-graph`, `devia-code-mode` MCP servers (each spawned by the agent with `process.execPath` + `ELECTRON_RUN_AS_NODE=1`), the code-graph index worker and seed worker (`worker_threads`), the PTY shell.

## Features and the composition root

- `Feature` (`src/main/shared/feature.ts`): `id`, `register(ctx)`, optional `onReady`, `onBeforeQuit`. `FeatureContext` gives `ipc`, a typed `send` (channel → payload enforced by `RendererEvents` in `src/shared/contracts/events.ts`) and a lazy `getMainWindow()`.
- `src/main/shell/composition-root.ts` builds every feature and registers its IPC handlers; it owns the singletons (config, session store, registry, queue, audit log, snapshot).
- Feature isolation: everything inside `src/main/features/<x>/` is private; cross-feature collaboration goes through ports in `src/main/shared/ports/`. `claude-runner` must not import agent-specific code (guard test).

## IPC conventions

- Every channel name lives in the `IPC` const object in `src/shared/contracts/ipc-channels.ts` (never a string literal). Full list: [../reference/ipc-channels.md](../reference/ipc-channels.md).
- Adding a channel: (1) add to `IPC`, (2) add the method to `devia-bridge.ts` (and `preload.ts`), (3) register the handler in the feature (wired in `composition-root.ts`), (4) add the typed wrapper to `ElectronApiService`. `src/main/shell/preload-channel-sync.test.ts` keeps preload and contract aligned.
- Request/response uses `ipc.handle`; one-way renderer → main uses `ipc.on`; main → renderer events use the typed `send` (e.g. `process:start`, `claude:output`, `queue:changed`, `session:handoff`).

## Tooling-side channel between agent and Devia

MCP servers cannot call main. `devia-ui` uses an on-disk rendezvous per run (`os.tmpdir()/devia-ui/<runId>`); `devia-kanban`/`devia-memory` write the same JSON files main reads (main invalidates its cache first); code-graph reads its own SQLite file readonly; code-mode writes event JSONL that main relays.

## Does NOT

- Does NOT expose Node or Electron objects to the renderer; no remote module.
- Does NOT use string-literal channel names anywhere.

## Related

- [agent-layers.md](agent-layers.md), [persistence-layout.md](persistence-layout.md), [../features/chat-ui.md](../features/chat-ui.md), [../reference/ipc-channels.md](../reference/ipc-channels.md)
