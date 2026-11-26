# Agents

Single source of truth for how to work in this repository. `CLAUDE.md` is only a
pointer back to this file.

## What this app is

Devia is an open-source (Apache-2.0) Electron desktop app that drives CLI coding agents (Claude Code, Codex, Gemini CLI, OpenCode, Pi and more) from a single window. The renderer is an Angular 21 SPA; the main process is Node.js TypeScript compiled to CommonJS. Everything runs locally.

This file is for AI consumption: keep it in English. Community files (`README*`, `CONTRIBUTING.md`, `SECURITY.md`) are English with the Spanish README as the original; UI strings live in `src/renderer/assets/i18n/*.json`. Reply to the maintainer in Spanish.

---

## Repo layout

```
devia-app/
├── src/
│   ├── main/               Electron main process (TS → dist/main/main/, CommonJS)
│   │   ├── shell/          Entry points: main.ts, preload.ts, composition-root.ts
│   │   ├── shared/         Cross-feature ports, persistence helpers, workspace-paths
│   │   └── features/       36 bounded contexts (one folder = one feature; each has a page in docs/features/)
│   │
│   ├── renderer/           Angular 21 SPA (TS → dist/renderer/)
│   │   ├── main.ts         bootstrapApplication
│   │   ├── styles.scss     M3 dark theme + --dv-* CSS tokens
│   │   ├── app/            All Angular components and services
│   │   ├── assets/         Images, icons, i18n JSON files
│   │   └── types/devia.d.ts Type declaration for window.devia (contextBridge)
│   │
│   ├── shared/             Cross-process code — NO Electron imports here
│   │   ├── contracts/      devia-bridge.ts, ipc-channels.ts, events.ts
│   │   └── domain/         Plain domain types (no logic, no side effects)
│   │
│   └── libs/               @devia/ui (components) and @devia/styles (tokens), consumed from source
│
├── build/                  electron-builder resources (icon, macOS entitlements)
├── scripts/                postinstall (native rebuild), audit gate, release manifest, copy-assets (wasm + .sql → dist)
├── tools/                  i18n parity, scss token check, agent e2e harness, code-graph oracle + bench
├── tests/                  Visual-regression and MCP smoke scenarios
├── docs/                   SOURCE OF TRUTH for what Devia does and does NOT do (English): features/, architecture/, reference/, capabilities.md
├── NOTICE                  Third-party attribution (codegraph, tree-sitter grammars, cytoscape, …)
├── vitest.config.ts        Main-process test config (env: node)
├── vitest.angular.config.ts Renderer test config (env: jsdom + Angular)
├── tsconfig.json           Base TypeScript config (strict: true) + @devia/* paths
├── tsconfig.main.json      Main process (module: commonjs, rootDir src, includes src/main + src/shared)
└── tsconfig.app.json       Renderer (Angular, includes src/renderer + src/shared)

The compiled main process keeps a doubled `main/` on purpose: `dist/main/main/shell/main.js`.
```

---

## Process / IPC model

- **Main process** owns: agent CLI spawn (child_process/node-pty), filesystem persistence (`~/.devia-app/`), git, docker, shell exec.
- **Preload** (`src/main/shell/preload.ts`) exposes `window.devia` via `contextBridge`. Shape declared in `src/shared/contracts/devia-bridge.ts`, consumed via `src/renderer/types/devia.d.ts`. Never add to `window` directly — go through the bridge contract.
- **IPC channels** are centralized in `src/shared/contracts/ipc-channels.ts`. Never use string literals for channel names — add to the const object there.
- **Composition root** (`src/main/shell/composition-root.ts`) wires all features. New features register IPC handlers here.
- **Spellcheck + context menu** (`src/main/shell/context-menu.ts`): the window runs with `webPreferences.spellcheck: true` (it was `false`, so nothing was ever underlined). Electron has NO default context menu, so `installContextMenu` builds one (suggestions → `replaceMisspelling`, add to dictionary, cut/copy/paste/select all) — without it the underline is useless. macOS uses the native checker (auto language); on Windows/Linux `pickSpellCheckerLanguages` maps the OS languages to Hunspell dictionaries (downloaded from Google's CDN on first use). Opt a field out with `spellcheck="false"` (paths, secrets, code).
- **Renderer** accesses the bridge exclusively through `ElectronApiService` (`src/renderer/app/core/services/electron-api.service.ts`). Never call `window.devia` directly in components.

---

## Features (src/main/features/)

One row per feature: a one-line summary and the page that holds the detail. **`docs/` is the source of truth for what each feature does and does NOT do** (see "Documentation is part of the change" below). The full capability matrix is [docs/capabilities.md](docs/capabilities.md); the index is [docs/README.md](docs/README.md).

| Feature | Purpose | Docs |
| --- | --- | --- |
| `claude-runner` | Agent-agnostic core of a run: builds the `AgentRunPlan`, composes the system prompt, lifecycle, `RunInteraction` (cards + answers), auto-resume | [claude-runner](docs/features/claude-runner.md) |
| `agents` | S-30: one mapper per agent behind the `AgentMapper` port (`claude/`, `pi/`, `opencode/`, generic `acp/`, `LegacyMapper`) with typed wire contracts and golden fixtures | [agents](docs/features/agents.md) |
| `cli-adapters` | Agent defs (binary, models, flags, auth probes), detection, spawn-only launcher, legacy stream parsers, error classification, raw CLI log capture | [cli-adapters](docs/features/cli-adapters.md) |
| `workspace` | Config persistence, project listing, tech detection, new-from-base, trash/move | [workspace](docs/features/workspace.md) |
| `sessions` | Per-project chat history on disk (`~/.devia-app/sessions/`), switch/adopt/delete, stats rollups | [sessions](docs/features/sessions.md) |
| `session-import` | Import existing Claude, Codex and Grok sessions with native resume | [session-import](docs/features/session-import.md) |
| `queue` | Per-session instruction queue (add, reorder, pause) | [queue](docs/features/queue.md) |
| `terminal` | node-pty terminal per project | [terminal](docs/features/terminal.md) |
| `git` | Status watcher, diff, branch switcher, ff-only pull, session worktrees | [git](docs/features/git.md) |
| `mcp` | MCP server registry, per-agent native-config sync, exposure (direct / code mode), catalog | [mcp](docs/features/mcp.md) |
| `project-tree` | Read-only file tree with git status overlay | [project-tree](docs/features/project-tree.md) |
| `skills` | Skill discovery (GitHub/local), install into each agent's dir, list, remove | [skills](docs/features/skills.md) |
| `skill-registry` | Per-project `.devia/skill-registry.md` index | [skill-registry](docs/features/skill-registry.md) |
| `sub-agents` | Reusable sub-agent definitions synced to each CLI | [sub-agents](docs/features/sub-agents.md) |
| `prompt-packs` | Prompt packs scanned from disk (no UI yet) | [prompt-packs](docs/features/prompt-packs.md) |
| `starter-kits` | S-39: the Devia Method kit delivered to every agent | [starter-kits](docs/features/starter-kits.md) |
| `cross-agent` | S-56: workers of other agents for the method loop (role→agent map per project, run completion, limits) | [cross-agent](docs/features/cross-agent.md) |
| `status` | Process/state snapshot for the status modal | [status](docs/features/status.md) |
| `docker-compose` | deploy / down / logs per project | [docker-compose](docs/features/docker-compose.md) |
| `outbox` | Files emitted by the agent, archived and optionally relayed to the chat | [outbox](docs/features/outbox.md) |
| `attachments` | Composer attachments of any type, caps enforced in both processes | [attachments](docs/features/attachments.md) |
| `voice` | Local Whisper dictation | [voice](docs/features/voice.md) |
| `clone` | `git clone` into the workspace | [clone](docs/features/clone.md) |
| `pinned-projects` | Sidebar pinning | [pinned-projects](docs/features/pinned-projects.md) |
| `shell` | openPath/reveal policy, open in IDE, upgrade link | [shell](docs/features/shell.md) |
| `security` | Audit log plus a guard library (several primitives not wired in) | [security](docs/features/security.md) |
| `memory` | Devia persistent memory, `devia-memory` MCP server, engram import | [memory](docs/features/memory.md) |
| `ui-tools` | S-25: all interface tools as one `devia-ui` MCP server | [ui-tools](docs/features/ui-tools.md) |
| `sdd` | Kanban board and the `devia-kanban` MCP server | [sdd](docs/features/sdd.md) |
| `snapshot` | Config snapshots before destructive MCP/skills/sub-agent writes | [snapshot](docs/features/snapshot.md) |
| `context-compression` | Auxiliary-LLM compression and handoff summaries (not used by runs) | [context-compression](docs/features/context-compression.md) |
| `context-recovery` | Re-inject memory after the agent compacted itself | [context-recovery](docs/features/context-recovery.md) |
| `auto-update` | electron-updater wiring | [auto-update](docs/features/auto-update.md) |
| `code-graph` | S-44: own code graph, `devia-code-graph` server, `/graph` view | [code-graph](docs/features/code-graph.md) |
| `code-mode` | S-50: sandboxed scripts over the user's MCP servers | [code-mode](docs/features/code-mode.md) |
| `telegram-controller` | Telegram remote control, UI-tool policy for remote runs, file relay | [telegram-controller](docs/features/telegram-controller.md) |

Cross-cutting capabilities: [run-modes](docs/features/run-modes.md), [auto-continue](docs/features/auto-continue.md), [session-stats](docs/features/session-stats.md), [session-handoff](docs/features/session-handoff.md), [split-view](docs/features/split-view.md), [chat-ui](docs/features/chat-ui.md), [settings](docs/features/settings.md).

---

## Renderer architecture (src/renderer/app/)

The renderer is a **single-page Angular 21 app** with no NgModules, no RxJS (except where Angular itself requires it). All state flows through signals.

Key services:

- `AppStateService` — central signals store: config, chats, assistantStreams, pendingQuestions, gitInfo, projects, queue. Implements `OnDestroy` for timer cleanup.
- `ElectronApiService` — typed wrapper over `window.devia`. Only service that touches the bridge.
- `I18nService` — language switching via @ngx-translate.

Key components:

- `AppComponent` — layout shell (titlebar + sidebar + chat + right-rail).
- `ChatPanelComponent` — message list, composer, question card. The message list is **bottom-anchored windowed** (S-4 T-75): only the tail slice (`windowedMessages = currentMessages().slice(firstVisibleIdx)`, window of 20) is mounted; a top sentinel + `IntersectionObserver` prepends older messages in chunks of 10 as the user scrolls up, preserving scroll via `afterNextRender` (scrollHeight delta). The window re-pins to the tail only on a real session change (keyed by `"<project>:<firstMessageId>"`) or while `stickToBottom()` — a same-session append while the user has scrolled up never collapses the mounted window.
- `MessageBubbleComponent` — renders markdown (marked + DOMPurify) + inline tool calls + diff viewer. Falls back to plain text if DOMPurify is unavailable (UC-FIX-016).
- `ToolCallCardComponent` — tool use details (input, output, status, diff).
- `DiffViewerComponent` — inline git diff with workspace-relative paths (UC-FIX-020). With `[commentable]="true"` (only the Cambios view sets it; the inline tool-call usage stays read-only) each non-hunk line opens an inline comment editor, and a bottom action bar offers **Cancelar** (discard + back to chat) and **Enviar a revisar** (build a `revisa:` prompt from the comments → `setComposerDraft` → back to chat). Comments live per-project in `AppStateService.reviewComments`, anchored to a diff snapshot: `reconcileReviewComments` (via `src/shared/domain/review-comment.ts`) prunes anchors that no longer resolve after a commit/stash/edit, so a stale line reference never reaches the agent.
- `SettingsModalComponent` — master-detail settings (sections: workspace, execution, appearance, memory, Devia Method, interface tools, remote control); detail in [docs/features/settings.md](docs/features/settings.md). The titlebar has a theme switcher and a kebab menu (Status, Stop all processes, zoom, Edit templates, Settings).
- `ModalShellComponent` (`src/renderer/app/shared/components/modal-shell/`) — reusable master-detail shell for the large modals (Settings, Skills, MCP servers, Sub-agents). Consumers pass `[sections]` (`ModalNavSection[]`) + a two-way `[(active)]` id and project each section's body inside an `@switch (active())`. Open these dialogs by spreading `WIDE_DIALOG_OPTIONS` into `dialog.open()` so they match the Kanban board size.

---

## Split-view multi-session (S-13)

Up to 4 panes (2×2), each with its own session; every ADDITIONAL pane runs in its own git worktree (isolation is mandatory) so agents never touch the same files. Run mode is persisted per session. Binding rules that must not regress: the primary pane runs on the real checkout; session identity is `runKey ?? projectName` everywhere in the runner; worktree/branch lifecycle belongs to Devia (an agent never creates, switches or removes them); `closePane`/adoption `flushSave` before `clearChat`; the terminal is hidden while split is active. Detail, recovery chain and persistence: [docs/features/split-view.md](docs/features/split-view.md), [docs/features/run-modes.md](docs/features/run-modes.md).

---

## Shared domain (src/shared/domain/)

Plain TypeScript interfaces, no logic, no side effects. Key types:

| Type                                                                             | File                        |
| -------------------------------------------------------------------------------- | --------------------------- |
| `ChatMessage`, `ContentBlock`, `ToolCallRecord`, `MessageUsage`                  | `chat.ts`                   |
| `AgentEvent` (text_delta, tool_use, usage, thinking, …)                          | `agent-event.ts`            |
| `DeviaConfig` (workspaceRoot, agentId, memory, remoteControl, …)                 | `config.ts`                 |
| `RunId`, `DetectedAgentView`, `isForeignEvent()`                                 | `agent.ts`                  |
| `PersistedSession`, `parsePersistedSession()`, `extractSessionIdentity()`        | `session.ts`                |
| `buildHandoffBrief()`, `HandoffBrief` (S-2 cross-agent handoff)                  | `handoff.ts`                |
| `toRelativePath()`                                                               | `path-display.ts`           |
| `IdeId`, `IdeInfo`, `IDE_CATALOG`, `buildIdeSpawn()`, `availableIdes()`           | `ide.ts`                    |
| `ReviewComment`, `buildReviewPrompt()`, `diffSignature()`, `reconcileComments()` | `review-comment.ts`         |
| `GraphNode`, `GraphEdge`, `CodeGraphStatus`, `IndexProgress`, `GraphViewPage`, `NODE_KINDS`, `EDGE_KINDS` (S-44) | `code-graph.ts`             |
| IPC channel names                                                                | `contracts/ipc-channels.ts` |
| Bridge interface                                                                 | `contracts/devia-bridge.ts` |

---

## Conventions

### TypeScript

- **Two tsconfigs**: `tsconfig.main.json` (main → CJS, `rootDir: src`, includes `src/main` + `src/shared`) and `tsconfig.app.json` (renderer → Angular, includes `src/renderer` + `src/shared`).
- `exactOptionalPropertyTypes: true` everywhere. Never assign `undefined` to an optional field; omit it instead.
- `strictNullChecks`, `noImplicitAny`, `noImplicitOverride` — all on.

### Angular

- **Standalone components only.** No NgModules.
- **Signals everywhere**: `signal()`, `computed()`, `input()`, `output()`. No `BehaviorSubject` where a signal suffices.
- **OnPush change detection** on every component.
- **Material 3 tokens**: use `--dv-*` CSS custom properties defined in `src/renderer/styles.scss`. Never hardcode colors.
- **No `window.devia` in components**: go through `ElectronApiService`.
- **i18n**: all user-visible strings go through `| translate` pipe and live in `src/renderer/assets/i18n/*.json`.

### Main process

- **Feature isolation**: everything inside `src/main/features/<x>/` is private to that feature. Cross-feature collaboration goes through ports in `src/main/shared/ports/`.
- **`systemPromptStrategy` required**: every `RuntimeAgentDef` must declare `'argv' | 'stdin-prepend' | 'unsupported'`. A startup assertion warns if a CLI adapter uses `'unsupported'`.
- **IPC handlers** registered once in `composition-root.ts`. Never use raw string channel names.
- **Kill on cancel**: Windows spawns via `cmd.exe` shim use `taskkill /T /F /PID` to kill the full process tree (UC-FIX-003).

### Shared

- **No Electron imports in `src/shared/`** — it must stay portable between main and renderer.
- **No Node.js APIs in `src/shared/domain/`** — pure TypeScript types and pure functions only.

### Security guards (implemented, do not revert)

- `resolveInsideWorkspace()` before any fs operation on user-supplied paths.
- `parsePersistedSession()` at every session read/write boundary.
- `classifyDetectionError()` strips host paths from agent detection errors before IPC.
- Prompt-pack scanner uses `lstatSync` + `isSymbolicLink()` guard.
- `isForeignEvent()` strict filter in `consumeAgentEvent` (runId mismatch drops event).
- Audit log uses timestamped rotation (`audit.log.<isoTs>.jsonl`) — never overwrites history.
- `checkOutboundFile()` (roots + `realpath` + `SECRET_PATH_PATTERNS` denylist) in the `devia-ui` server AND again in main (`RunFileGate`) before any file leaves through the chat relay (S-32). The denylist is a code constant, never a setting.

### Comments

Write no comments by default. Only document non-obvious _why_: hidden constraints, workarounds, invariants. Never document _what_ the code does.

---

## Git workflow (binding for every human and every agent)

| Branch | Role | How code gets in |
| --- | --- | --- |
| `main` | Release delivery branch. Only finished batches of fixes/features. | **Only** by a PR `dev` → `main`. Never a direct commit, never a feature branch straight into it. |
| `dev` | Consolidation branch for finished features and fixes. | **Only** by PR (`feature/*`, `fix/*`, `docs/*`, … → `dev`). Never a direct commit. |
| `feature/*`, `fix/*`, `docs/*`, … | Where ALL development happens, feature or fix alike. | Always created from the current `dev`, and merged back into `dev` by PR. |

- **Never develop in a checkout where Devia is running.** The maintainer's checkout (`/Users/dherrero/repos/devia-app`) stays on `dev`, clean and compilable: it is the copy they build and run the app from. Work in a feature branch checked out in its own worktree (a sibling directory such as `devia-app-<feature>`), created by the user or by a Devia pane — an agent never creates, moves or removes worktrees or branches of the user's checkout on its own initiative.
- **Never leave work in progress uncommitted in a tree the app builds from.** `tsconfig.main.json` compiles everything under `src/main`: an untracked, half-written file or a dirty `queries.ts` breaks `npm run build` and therefore the whole app. Partial work lives on a feature branch in its worktree, committed in coherent steps.
- Commits are local until the user says to push. An agent never pushes, never opens or merges a PR and never touches `main`/`dev` without an explicit request.
- Commit messages follow Conventional Commits (`release.yml` bumps the version from them).
- Branch names: `feature/<slug>` (new functionality), `fix/<slug>`, `refactor/<slug>`, `docs/<slug>`, `chore/<slug>` (tooling, deps, scripts); the older `feat/<slug>` form is also accepted.
- Never bypass hooks (`--no-verify`, `--no-gpg-sign`) without explicit user authorization.

### Devia must keep working after every change (definition of done)

A task is not done until, in the worktree of its branch, all of this passes with the real output read:

```bash
npm run typecheck   # both tsconfigs
npm run build       # main (CJS) + renderer (compiles the Angular templates, which typecheck does not)
npm test            # main + renderer + libs suites
npm run lint
```

- Anything that ships in the packaged app (new runtime dependency, wasm/asset, worker or MCP entry file) additionally needs `npm run pack:dir` and a launch of the unpacked app once before its PR; assets are copied to `dist` by `scripts/copy-assets.cjs`.
- Before a PR to `dev`: rebase or merge the latest `dev` into the branch, repeat the gate above, and start the app (`npm run dev` after `npm run build`) to confirm it opens and the touched feature works. Say plainly what was and was not verified.
- If a change cannot be finished in one sitting, it stays on its branch; `dev` and `main` must never be left in a state that does not build.

---

## Testing

```bash
npm run test:main      # Vitest (node env) — src/main + src/shared + tools **/*.test.ts
npm run test:renderer  # Vitest (jsdom + @analogjs/vitest-angular) — src/renderer/**/*.spec.ts
npm run test:libs      # Vitest (happy-dom) — @devia/ui specs
npm test               # All three suites
npm run test:coverage  # Main-process coverage report; thresholds in vitest.config.ts only ratchet UP
npm run typecheck      # tsc --noEmit on both tsconfigs (does NOT compile Angular templates — `npm run build` does)
```

- **Main process tests**: pure unit tests with in-memory fakes. Never mock real CLIs (Claude, Codex, etc.).
- **Renderer tests**: Angular TestBed via `@analogjs/vitest-angular`. Setup in `src/renderer/test-setup.ts`.
- **Spec stubs**: `*.spec.ts` files with `it.todo()` document planned TestBed tests that require a DOM runner.
- **Coverage thresholds**: set in `vitest.config.ts` just under the measured numbers. Never lower one to make a build green.

---

## Build & run

A single npm project at the repository root (Node `>=26.13.0` (Node 26 LTS), see `.nvmrc`). There is no monorepo tooling: every script below is plain `tsc` / `ng` / `vitest` / `electron-builder`. `package.json` is both the project manifest and the electron-builder config (`build` field); only what the main process needs at runtime (`electron-updater`, `node-pty`, `web-tree-sitter`, `zod`, `@agentclientprotocol/sdk`) is in `dependencies` (what gets packaged) — everything the Angular build bundles is a `devDependency` on purpose.

```bash
npm install
npm run dev            # tsc watch (main) + ng build watch (renderer) + electron --dev (DevTools)
npm run dev:live       # same, but the renderer is served by `ng serve` on :4300 (hot reload)
npm run start          # build, then electron without --dev
npm run build          # main (CJS) + renderer (production)
npm run typecheck      # tsc --noEmit on tsconfig.main.json + tsconfig.app.json
npm run lint           # eslint over src/main, src/shared, src/renderer, tools
npm test               # main + renderer + libs suites
npm run pack           # electron-builder for the current OS (signs if a Developer ID is in the keychain)
npm run pack:dir       # unpacked, UNSIGNED app in release/ — quickest way to test packaging
npm run pack:win|pack:mac|pack:linux
npm run audit:runtime  # npm audit gate for packaged dependencies
```

**Iteration loop**: `npm run dev` runs `tsc --watch` (main), `ng build --watch` (renderer) and `electron` in parallel. Renderer changes → Ctrl+R. Main changes → kill + restart `npm run dev` (or run `npm run watch:main` alone in a side terminal and relaunch electron manually).

**Startup race (S-25, cost hours to diagnose):** because those three run IN PARALLEL, electron boots in a couple of seconds while the initial `tsc` pass takes much longer — so a fresh `npm run dev` after main-process changes loads the PREVIOUS `dist/main`, and the main process does NOT hot-reload. Symptom: the renderer shows your new code while main behaves like the old build (e.g. a new bundled MCP server never reaches the agent). **Run `npm run build` FIRST, then `npm run dev`.** To confirm which build main is actually running, check an artefact it writes — e.g. `.claude/settings.local.json` should list `mcp__devia-ui` once S-25 is live.

**Native modules**: `node-pty` is a runtime `dependency` so electron-builder packages it. The `postinstall` hook (`scripts/rebuild-native.cjs`) rebuilds it for the Electron ABI in use.

**Packaging** (gotchas): electron-builder reads the `build` field of the root `package.json`; paths in it (`build/…`, `src/renderer/assets/images/Devia.PNG`) are relative to the repository root. `build.electronVersion` is pinned explicitly — **keep it in sync with the `electron` devDependency** when bumping Electron. **Do not rename the package** (`"name": "devia-app"`): Electron derives `app.name` and the userData folder (localStorage, Chromium state) from it, and a new name would orphan every installed user's data. The packaged `app.asar` contains only `dist/main`, `dist/renderer` and `package.json` (~27 MB since S-44: the seven tree-sitter grammars add ~5 MB of wasm and `web-tree-sitter` the rest); if it suddenly grows well beyond that, something that should be a `devDependency` ended up in `dependencies`.

**macOS signing & notarization** (Developer ID — distribution outside the App Store): the `build.mac` block enables `hardenedRuntime` + `gatekeeperAssess: false` + `notarize: true`, with `build/entitlements.mac.plist` used for both `entitlements` and `entitlementsInherit`. The entitlements declare the Hardened Runtime exceptions Devia needs because it spawns child CLIs (node-pty/child_process) and the `devia-memory` MCP server via `ELECTRON_RUN_AS_NODE=1`: `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`, `allow-dyld-environment-variables`. Removing any of those breaks agent/terminal/MCP spawning in the signed build. Signing identity (`Developer ID Application`) is auto-detected from the login keychain. Notarization credentials come from env vars at `npm run pack:mac` time — `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` (app-specific password) or `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` (App Store Connect API key). With no credentials present electron-builder still signs but **skips notarization silently** (so local non-release packaging does not hard-fail).

---

## Subsystems (summaries; detail lives in `docs/`)

- **Process / IPC, persistence, build, distribution.** [process-and-ipc](docs/architecture/process-and-ipc.md), [persistence-layout](docs/architecture/persistence-layout.md) (everything under `~/.devia-app/`), [build-and-distribution](docs/architecture/build-and-distribution.md) (packaging gotchas: keep `build.electronVersion` in sync with the `electron` devDependency; never rename the package `devia-app`; never change `build.publish` owner/repo or move the landing's `updates/latest.json`; macOS Hardened Runtime entitlements are needed to spawn CLIs; anything that ships in the app needs `npm run pack:dir`), [reference/ipc-channels](docs/reference/ipc-channels.md). Adding an IPC channel: add to `IPC` in `ipc-channels.ts`, add the method to `devia-bridge.ts`, register the handler in the feature (wired in `composition-root.ts`), add the typed wrapper to `ElectronApiService`.
- **Agent layers** (render ↔ core ↔ mappers ↔ CLI, S-30). The core is agent-agnostic (`core-is-agent-agnostic.test.ts`); each agent has a mapper; the launcher only spawns. Everything managed in Devia (MCP, skills, sub-agents) reaches whichever agent is active through its mapper. Per-turn context (S-40): Claude freezes its first system prompt, so volatile parts travel in a `<devia-turn-context>` block. [architecture/agent-layers](docs/architecture/agent-layers.md), [agents](docs/features/agents.md), [reference/agents-matrix](docs/reference/agents-matrix.md). Adding an agent: record fixtures with `tools/agent-e2e` → `wire.ts` → decoder + golden test → `mapper.ts` → register in `DEDICATED_MAPPERS` → snapshot in the harness.
- **ACP (S-41)** and **multi-agent support.** One generic `AcpMapper` on `@agentclientprotocol/sdk` pinned at 1.9.0 (do not bump without porting: 2.x removed `ClientSideConnection`). 13 agent defs; per-agent flags, prompt strategy, continuity and MCP targets in [reference/agents-matrix](docs/reference/agents-matrix.md); mode flags in [run-modes](docs/features/run-modes.md).
- **UI tools — the `devia-ui` MCP server (S-25).** Claude Code 2.1.220 removed `AskUserQuestion` from headless runs, so questions, plan approval, review, confirm, pick, notify, skills and send-file travel as ONE server (adding a tool must not mean adding a server). Do not "restore" the PreToolUse hook. [ui-tools](docs/features/ui-tools.md).
- **Devia Method (S-39)** (own development method, state on the kanban, no plan files). [starter-kits](docs/features/starter-kits.md), [docs/devia-method/](docs/devia-method/00-audit.md).
- **Kanban / SDD.** [sdd](docs/features/sdd.md). **Memory + engram import.** [memory](docs/features/memory.md). **Cross-agent handoff.** [session-handoff](docs/features/session-handoff.md). **Session import.** [session-import](docs/features/session-import.md).
- **Code Graph (S-44).** [code-graph](docs/features/code-graph.md). Every engine file adapted from codegraph carries an attribution line kept in sync with `NOTICE` by `tools/notice-code-graph.test.ts`; bump `EXTRACTION_VERSION` whenever an extractor changes what it stores.
- **Code Mode (S-50).** [code-mode](docs/features/code-mode.md). Devia's own four MCP servers are never put behind a script; packaging needs the bundled TypeScript libs (`scripts/copy-assets.cjs`).
- **Security guards (implemented, do not revert).** The full list with code locations is [architecture/security-guards](docs/architecture/security-guards.md). `devia_send_file` is an exfiltration channel: never relax its layered defences; the secret denylist is a code constant, never a setting.

**Rule for everything agent-facing:** this file is for people developing Devia; a user who installs the app never has it. Whatever an agent must know or obey at runtime (plan-mode limits, tool names, harness delivery) must travel through what Devia itself sends (the composed system prompt, the per-turn block, `session/new`, the mapper) and be covered by a test, never live only here or in any file of this repository.

---

## Documentation is part of the change (binding)

`docs/` is the source of truth for what Devia does and does NOT do. It is written in English and read mostly by AI agents (including agents analysing Devia from other projects), so it must stay accurate.

- Every new feature, and every change to an existing feature, MUST update in the SAME PR: its page `docs/features/<name>.md`, its row in `docs/capabilities.md`, and the index in `docs/README.md`. Removing or deprecating a capability updates the same three places (`Status:` and a `Does NOT` entry).
- A new folder under `src/main/features/` needs its own `docs/features/<folder>.md` (`tools/docs-parity.test.ts` fails otherwise). Renderer-only or cross-cutting capabilities get their own page too.
- Pages follow the template `docs/features/_template.md` and the rules in `docs/CONVENTIONS.md`: English, dense, `path:symbol` references, `Does NOT` verified against the code, `UNVERIFIED:` for anything not checked, `Verified:` updated to the commit you checked against.
- Code wins over docs: when they disagree, fix the doc in the change that exposed it and note the discrepancy under `## Gotchas`.
- Do not copy detail into this file. Put it in `docs/` and link it; this file keeps conventions, workflow and one-line summaries.

---

## Language rules

- **AI-targeted files** (this file, `.claude/` content, sub-agent prompts, code comments, JSDoc): **English**.
- **Human-targeted files** (README.md, UI strings, error messages, release notes): **Spanish**.
- **Always reply to the user in Spanish.**

---

---

## Shell conventions

- **Never prefix commands with `cd <project-root> &&`** — the shell working directory is already set to the project root automatically. Write commands directly: `npx tsc --noEmit`, `npx vitest run`, `git status`, etc.
