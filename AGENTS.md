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
│   │   └── features/       20 bounded contexts (one folder = one feature)
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
├── scripts/                postinstall (native rebuild), audit gate, release manifest
├── tools/                  i18n parity, scss token check, agent e2e harness
├── tests/                  Visual-regression and MCP smoke scenarios
├── docs/                   Technical plans, stories, architecture decisions
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
- **Renderer** accesses the bridge exclusively through `ElectronApiService` (`src/renderer/app/electron-api.service.ts`). Never call `window.devia` directly in components.

---

## Features (src/main/features/)

| Feature           | Purpose                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `claude-runner`   | The agent-agnostic core of a run: builds the `AgentRunPlan`, composes the system prompt, lifecycle, `RunInteraction` (cards + answers) — see "Agent layers" |
| `agents`          | S-30: one mapper per agent behind the `AgentMapper` port (`claude/`, `pi/`, `opencode/` + `LegacyMapper` for the rest), each with its typed wire contract, decoder and golden fixtures |
| `cli-adapters`    | Agent defs (binary, models, flag builders, auth probes), detection, the spawn-only launcher, the legacy agents' stream parsers, error classification. `raw-stream-logger.ts` (S-4 T-76) captures raw child-process stdout/stderr as JSONL to `~/.devia-app/logs/agent-cli/<agentId>/` for diagnosing parsers, gated on `IS_DEV` or `DEVIA_LOG_RAW_CLI=1` (size-capped, 7-day purge) — side-effect only, never blocks the parser |
| `workspace`       | Config persistence, project listing, tech detection, file-system operations                                            |
| `sessions`        | Per-project chat history on disk (`~/.devia-app/sessions/`)                                                            |
| `session-import`  | S-20 (generalises S-18): import pre-existing CLI-agent sessions (Claude `~/.claude/projects`, Codex `~/.codex/sessions`) into Devia's session store for workspace projects, via a per-agent (reader + parser) registry |
| `queue`           | Per-project instruction queue; enqueue, dequeue, reorder                                                               |
| `terminal`        | node-pty-backed terminal per project                                                                                   |
| `git`             | Git status watcher, diff parser, sync, **branch switcher (list + checkout, S-22)** — `CliGitBrancher.list` (`for-each-ref refs/heads refs/remotes`) feeds the footer modal; `checkout` switches the BASE checkout (local `git checkout`, remote `--track`, never `--force`). IPC `git:list-branches` / `git:checkout`; renderer guards in `AppStateService.checkoutBranch` block while split-view active or an agent runs. **One-click pull**: the footer "behind N" chip triggers `git:pull` (`CliGitSyncer.pull` → `git pull --ff-only`, never merges/rebases) via `AppStateService.pullGit` (blocked while an agent runs) |
| `mcp`             | MCP server registry (loaded at `register()`, watched by `McpConfigWatcher` for live external-edit refresh, #274) + temp config builder for Claude's `--mcp-config` flag |
| `project-tree`    | File tree reader for the right-rail file browser                                                                       |
| `skills`          | Skills discovery (GitHub + local), install, list, remove                                                               |
| `prompt-packs`    | Custom system prompt packs per project                                                                                 |
| `status`          | Process/state telemetry for the statusbar                                                                              |
| `docker-compose`  | deploy / down / logs orchestration                                                                                     |
| `outbox`          | Archive files emitted by agent → `~/.devia-app/outbox-archive/`. **S-32:** `flush(projectPath, check?)` reads `<effective cwd>/outbox/` (the session worktree for an isolated pane, not `workspaceRoot/<project>`) and runs BEFORE `onProcessEnd`, in both `onDone` and `onError`. When the run `canSendFiles`, each REGULAR file is validated by the run's `RunFileGate` at its ORIGINAL path (inside the send roots) before it is moved; admitted files are published to the `RunGateway` as `file` events pointing at the ARCHIVED copy (minted by Devia, so trusted although outside the roots), refused ones (and symlinks, archived but never sent) as `file_rejected` (name + reason only). The admitted identity (`dev`/`ino`) survives the archive rename; a cross-device copy+unlink is re-bound to the copy by `rebindArchivedRunFile` (still a single-link regular file of the validated size, else `file_rejected` with reason `changed`). Without `canSendFiles` nothing is published. The renderer's `outbox:file` still fires AFTER `process:end`, routed by session identity |
| `attachments`     | Composer attachments of ANY file type (drop / paste / paperclip picker). `FsAttachmentEnricher` saves each one under `<deviaDir>/attachments/` (unicode-safe name, extension kept) and appends a per-kind note to the prompt (`buildAttachmentInstruction` in `src/shared/domain/attachment.ts`, shared with Telegram): label by `attachmentKind` (image/pdf/text/video/audio/archive/binary), and for kinds Read cannot open, a hint to inspect them with Bash. Caps `MAX_ATTACHMENT_BYTES` (50 MB/file) and `MAX_ATTACHMENTS_TOTAL_BYTES` (200 MB/send) are enforced in BOTH processes: the renderer refuses before copying bytes over IPC (toast), `saveAll` re-checks the whole batch before writing anything. Images keep an object-URL thumbnail; other files render as icon + size chips (`previewUrl: null`) |
| `voice`           | Whisper transcription via @xenova/transformers (local, no API)                                                         |
| `clone`           | "New from base" project bootstrap (clone + init)                                                                       |
| `pinned-projects` | Sidebar project pinning                                                                                                |
| `shell`           | Free-form shell exec: openPath, reveal, openInIde + listIdes (multi-IDE catalog + per-OS detection in `shell/ide.ts`)   |
| `security`        | Audit log (JSONL, timestamped rotation, 30-day retention)                                                              |
| `memory`          | Devia internal persistent memory: JSON store + `devia-memory` MCP server + engram detection/import (S-1)               |
| `ui-tools`        | S-25: ALL of Devia's interface tools, served as one `devia-ui` MCP server (`devia_ask_user`, `devia_todo`, `devia_plan_approve`, `devia_request_review`, `devia_confirm`, `devia_pick`, `devia_notify`, `devia_skill`, and since S-32 `devia_send_file`). Replaces S-24's `devia-ask` server, whose code was deleted in S-25 F4.2 — only the cleanup of its leftovers in already-used projects remains (see Multi-agent support). Owns the per-project `ui-confirmations.json` store and a small IPC surface for the settings panel; everything else happens per run, driven by `RunInstructionUseCase` |
| `telegram-controller` | Telegram remote control (E-DSK-14): in-process long-poll bot that drives runs through the `RunGateway` and mirrors them in the UI; command router (`/status` reports active project + git branch/working-tree state + the active session's context-usage % and accumulated cost as plain numbers, read from the S-7 `SessionStats` rollup via the `sessionStats` port) + gated shell + optional desktop→chat conversation mirror (`remoteControl.mirrorDesktop`) + inbound attachments (photo/document/video/audio downloaded, saved via `AttachmentEnricher`, appended to the caption for the agent to Read). **`/clean` stops the in-flight run, resets the session, clears the visible thread, AND drops the pending queue:** `ResetSessionUseCase` first `registry.stopProject`s the active run (a reset starts from scratch, so a still-streaming run belongs to the OLD session — otherwise the killed agent keeps generating with the previous context and its output lands in the fresh session) and then resets the main-process registry pointers; `claude.ipc.ts` wraps it in `resetSessionFor` (reset + `queue.clear` so parked instructions from the old conversation don't dispatch into the fresh session — Telegram CAN queue: `submitInstruction` enqueues remote-origin runs too while busy). The renderer side of the kill: `AppStateService.resetSessionLocal` also drops the in-flight `assistantStreams` entry for the key, so the trailing `process:end` from the killed run can't finalise the old partial reply into the now-fresh thread. The Telegram path (`bindResetSession`) additionally emits the `session:reset` event because the renderer owns the in-memory chat; the renderer subscribes and runs `AppStateService.resetSessionLocal` (clear in-memory chat + "session reset" marker + immediate persist + refresh the per-base session list) — the single source of truth the chat-panel button and the sidebar reset also call. Without the event the renderer kept appending the next instruction to the SAME on-disk session/thread. The renderer-initiated `IPC.sessionReset` path also goes through `resetSessionFor` (so the desktop reset drains the queue too) but does NOT emit the event (it clears its own chat state), so there is no double-clear. Sleep/wake resilient: the poller caps each long-poll with a client-side timeout and exposes `wake()`; the feature wires `powerMonitor('resume') → wake()` (dead socket reconnects at once instead of stalling on undici's 300s bodyTimeout) and holds a `powerSaveBlocker('prevent-app-suspension')` only while the bot is connected. **UI tools over Telegram (S-25 F3.1, generalises S-24):** a remote user can't click anything, so a run started from the bot carries `origin: 'remote'` (threaded `RunGateway.submit → RunInstructionUseCase.execute`, and persisted on queued items so a queued remote run keeps it). S-24 withheld the whole server; S-25 decides **tool by tool**: the tools that need no interaction survive (`devia_todo`, `devia_notify`, `devia_skill`, plus `devia_send_file` when `canSendFiles` — S-32) and the five that carry a decision are withheld. `devia_notify` is MORE useful there than on the desktop — the chat is the only channel someone away from their desk has. Measured effect: a remote turn carries three tool schemas (four with `devia_send_file`) in the cached prefix instead of seven. The agent learns the plain-text equivalent of every withheld capability from `infrastructure/ui-tools-protocol.ts`, the pack shared with any run that lacks them; `infrastructure/remote-protocol.ts` adds only what is specific to the chat relay (no clickable UI at all, phone-sized replies) and deliberately does NOT restate the fallback's rule. A runtime safety net remains for an agent's OWN built-in picker: it auto-answers with a canned "you're on Telegram, re-ask as text" tool result through that agent's channel (`writeToolResult` — never the rendezvous file, which nothing would read for a tool that was not delivered) **instead of** waiting for the 5-minute kill timeout. Permission requests (ACP) are left untouched. **File output (S-32):** the `RunForwarder` accumulates the run's `file` events (deduped by path) alongside the text and, once the router calls `finish()` after `end`, sends the text reply FIRST (with `📎 N archivo(s) a continuación`) and then the files via `TelegramClient.sendFile` / `sendMediaGroup` (multipart, global `FormData`/`Blob`; one 429 retry honouring `retry_after` ≤ 30 s). `planFileBatches` orders them: photo+video albums, document albums, audio albums — max `MAX_MEDIA_GROUP` (10) per album, each item keeps its OWN caption (never joined). No photo over `MAX_PHOTO_BYTES` (10 MB) reaches this point: the gate (`revalidateOutboundFile`) already downgraded it to `document`. An album that fails with a **400** is retried item by item through `sendFile` (which can still fall back photo→document); any other album error (429/401/413/network) fails the whole batch. Files are read ONE AT A TIME right before the upload by `readOutboundFile`: `open(O_RDONLY | O_NOFOLLOW)`, `fstat` on the handle, then it must be a regular file with `nlink === 1`, the same `dev`/`ino` as the admitted `RunFile.identity` and exactly the validated `size` (≤ `MAX_UPLOAD_BYTES`), and only that many bytes are read from the handle — never `readFile` on the path. Refusals surface as `changed` / `hardlink` / `not-a-file` / `too-large`, a swapped-in symlink as `symlink` (ELOOP). A partly failed album rejects with `PartialUploadError` so each file gets its own outcome. Upload failures (one batch failing never aborts the rest) and `file_rejected` events (outbox files the gate refused, and `devia_send_file` requests main refused on revalidation, `source: 'tool'`) are reported in ONE trailing `⚠️ No pude enviar: name (reason), …` message. Files are still sent when the run ended in error, but **NOT when the user stopped it** (`end.error === 'stopped'` or `end.cancelReason === 'user'`, published by `claude.ipc.ts`; idle/question timeouts are not user stops): the reply carries `⏹️ *Detenido*` without the 📎 line, then ONE `⏹️ Ejecución detenida: no envié N archivo(s)` message, and each pending file is audited `failed:stopped`. A per-project promise tail makes the next run's reply wait for the previous run's uploads. The desktop mirror uses `pushFile(s)` (same `sendFiles`, but a disconnected bot REJECTS with `not-connected` so the file is audited `failed:not-connected`, never `delivered`). Every upload outcome is audited (`delivered` / `failed:<reason>`, name + size only) via `onFileOutcome → auditSendFile`. The Telegram limits (`MAX_UPLOAD_BYTES`, `MAX_PHOTO_BYTES`, `MAX_CAPTION_CHARS`, `MAX_MEDIA_GROUP`) live in `src/shared/domain/outbound-file-policy.ts` (shared by guard, gate and client; `telegram-client.ts` re-exports them) |

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
- `SettingsModalComponent` — agent selection (with main-process rejection handling), theme, i18n, env vars (secrets masked with `••••••••`), and the **Plantillas** (`bases.json`) editor section (ported from the retired standalone `BasesEditorModalComponent`; saves on its own button via `writeBasesJson`, independent of the global Save). Uses the `ModalShellComponent` master-detail layout. The titlebar is a single **settings gear** that opens this modal directly — the old kebab menu, the **Estado** (`StatusModalComponent`) and the standalone bases-editor modal were removed; **Parar todos los procesos** moved to the sidebar **Fijados** panel header (danger-tinted icon, mounted only while `runningPaths` is non-empty).
- `ModalShellComponent` (`modals/shell/`) — reusable master-detail shell for the large modals (Configuración, Skills, Servidores MCP, Sub-agentes), VS Code settings layout: header + left section rail + content + optional `[shellActions]` footer slot. Consumers pass `[sections]` (`ModalNavSection[]`) + a two-way `[(active)]` id and project each section's body inside an `@switch (active())`. Open these dialogs by spreading `WIDE_DIALOG_OPTIONS` (`modals/shell/wide-dialog-options.ts`) into `dialog.open()` so they match the Kanban board size (96vw / 1400px / 88vh, `panelClass: 'dsk-dialog'`).

---

## Split-view multi-session (S-13)

The central chat area can split into up to **4 panes** (2×2), each driving its own session+worktree with agents running in parallel inside one window. `ChatPanesContainerComponent` (`chat-panel/panes/`) owns the `PanesLayout` (columns × rows), mounts one `ChatPanelComponent` per pane, and renders the split icon state machine (vertical → horizontal → none) + the close flow (work-loss modal when the pane's agent is running OR its worktree is dirty).

- **Session identity.** The PRIMARY pane runs on the real checkout (no `runKey` → single-pane behaviour, `SessionKey === projectPath`). Every ADDITIONAL pane gets a fresh `sessionId` used as its `runKey` and an eagerly-created git worktree as cwd — **isolation is MANDATORY since S-3 F1.1** (`worktreePerSession` is deprecated and gates nothing; the runner re-points the cwd on `isolateSession` alone). A failed worktree (no git / no commits) degrades VISIBLY: warning icon next to the project name in the pane header (`ds-chat-header [unisolated]`, tooltip "Sin aislamiento") + explicit consent on the first send (`AppStateService.acknowledgeUnisolated`, in-memory per pane). The session branch is created from the repo's **default branch** (S-3 F1.2, `config.worktreeBaseRef: 'default-branch' | 'current'`, resolved by `buildGitFeature.baseRefFor` → `CliGitInspector.defaultBranchSync`, HEAD fallback) so a session never inherits the primary pane's in-flight commits. A pane keys ALL its live state in `AppStateService` by `sessionKey = runKey ?? effectiveProject`. Isolated runs get a **MANDATORY worktree protocol** appended to the system prompt (S-3 F3, `worktree-protocol.ts`, activated by `cwd !== project checkout`): no paths outside the cwd, no branch switching, no git against the base checkout.
- **Execution isolation.** The runner keys its registry/queue/event-dispatch by `identity = runKey ?? projectName` (separate from cwd resolution), so two panes of the same base repo never collide. The queue is keyed by session identity too.
- **Worktree lifecycle (S-3).** Renderer-supplied project ids are **workspace-relative keys** (`ProjectEntry.path`); the git feature resolves them via `resolveInsideWorkspace` before building any `WorktreeRef` — the exec cwd AND the worktree `projectKey` must derive from the absolute checkout, matching the ref the runner derives from its resolved cwd (passing the raw key made every `git worktree add` die with spawn ENOENT, so isolation never activated). Teardown policy: closing an additional pane with **ZERO activity** (no messages, no run) leaves no trace — worktree AND session branch are removed (IPC `git:worktree-cleanup` → `cleanupSession`); a pane with activity goes through `git:worktree-remove` so the **branch survives** for the F2.2 recovery chain (accidental close stays recoverable by re-opening the session). Adoption applies the same zero-activity rule to the old pane's eager worktree. **Explicitly deleting a session** from the sidebar (confirm modal) also tears down its worktree + branch when the persisted session carries `worktreeBranch` (`DeleteSessionUseCase` → git export `cleanupSessionWorktree`, best-effort after the history delete); a session running as a split pane (`registry.isRunning(sessionId)`) refuses deletion with `SESSION_BUSY`.
- **Layout persistence.** `PanesLayoutStore` (`providedIn: 'root'`) keeps the live layout per base project in memory (survives route changes) AND persists a reconstructible **skeleton** to localStorage on every commit (S-3 F2.3: arrangement + sessionIds only). After a restart, `ChatPanesContainerComponent.restoreFromDisk()` rebuilds the split by routing every additional pane through `session:adopt`, so the worktree **recovery chain** (S-3 F2.2) applies: persisted-`workdir` alive → reattach (native resume + files intact); worktree swept but `worktreeBranch` survives → recreate from the branch (`reattachWorktreeSync`, no `-b`) + "uncommitted lost" toast; neither → base checkout flagged `isolation: 'none'` (header warning icon + consent). `PersistedSession` carries `workdir` + `worktreeBranch` (S-3 F2.1, stamped through `chats:save-as`; hints validated by `isLiveSessionWorktree` — exists + contained in `<deviaDir>/worktrees`). Vanished sessions are skipped; a layout that collapses to one pane stays single-pane.
- **Composer draft persistence (S-14).** `ComposerDraftStore` (`src/renderer/app/features/chat/composer/`, `providedIn: 'root'`) keeps each pane's UNSENT composer state — draft text + pending attachments — keyed by `sessionKey`, so navigating to another route (Kanban, settings) and back never loses what the user was typing. `ChatPanelComponent` restores on mount / key change (a `composerInjection` still wins the first run), saves while typing via effect, captures the final state in `DestroyRef.onDestroy`, and CLEARS the entry on send. `PendingAttachmentsService.restore()` repopulates attachments without minting/revoking object-URLs (they stay valid because the document never reloads). Closing or re-keying (adoption) a pane purges its entry — `purge()` revokes preview URLs and TOMBSTONES the key so the panel's late destroy-save cannot resurrect it; a `snapshot()` read (composer remount) reopens the key. Memory-only: drafts do not survive an app restart.
- **Chat-history persistence (T-156).** An additional pane's history persists under the REAL base project with its own `sessionId` via `SaveChatUseCase.saveAs` (IPC `chats:save-as`), NOT under a synthetic `<UUID>` folder — so `listSessions(base)` lists it and it survives restart. The renderer redirects the save through `AppStateService.persistChat` using a `sessionPersistence` map registered by each additional `ChatPanelComponent` while mounted; the primary pane's on-disk layout is unchanged.
- **Focused-pane → shell (T-155/T-157).** `AppStateService.focusedSessionKey` (root single signal, `null` for the primary) is the single source of truth for which session the shell reflects. `focusedWorkdir` drives the right-rail git/tree; `focusedKey = focusedSessionKey() ?? selectedProject()` drives the footer/statusbar selectors (model, context %, cost, mode, "running" pill). The container sets both together (`focusShellOn`) on every split/focus/close/project-change. The sessions navbar marks active via `isSessionFocused(s)` and routes a click on a mounted session to focus its pane (`mountedPaneSessions` + `paneFocusRequest`).
- **Terminal in split (T-158).** The right-rail Terminal tab + pane (and the Mod+J shortcut) are hidden while `AppStateService.splitActive()` — the terminal runs on the base project, not per-pane, so it's ambiguous with 2+ panes; the rail falls back to the file tree.

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

A single npm project at the repository root (Node `>=24.14.1`, see `.nvmrc`). There is no monorepo tooling: every script below is plain `tsc` / `ng` / `vitest` / `electron-builder`. `package.json` is both the project manifest and the electron-builder config (`build` field); only `electron-updater` and `node-pty` are `dependencies` (what gets packaged) — everything the Angular build bundles is a `devDependency` on purpose.

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

**Packaging** (gotchas): electron-builder reads the `build` field of the root `package.json`; paths in it (`build/…`, `src/renderer/assets/images/Devia.PNG`) are relative to the repository root. `build.electronVersion` is pinned explicitly — **keep it in sync with the `electron` devDependency** when bumping Electron. **Do not rename the package** (`"name": "devia-app"`): Electron derives `app.name` and the userData folder (localStorage, Chromium state) from it, and a new name would orphan every installed user's data. The packaged `app.asar` contains only `dist/main`, `dist/renderer` and `package.json` (~12 MB); if it suddenly grows to tens of MB, something that should be a `devDependency` ended up in `dependencies`.

**macOS signing & notarization** (Developer ID — distribution outside the App Store): the `build.mac` block enables `hardenedRuntime` + `gatekeeperAssess: false` + `notarize: true`, with `build/entitlements.mac.plist` used for both `entitlements` and `entitlementsInherit`. The entitlements declare the Hardened Runtime exceptions Devia needs because it spawns child CLIs (node-pty/child_process) and the `devia-memory` MCP server via `ELECTRON_RUN_AS_NODE=1`: `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`, `allow-dyld-environment-variables`. Removing any of those breaks agent/terminal/MCP spawning in the signed build. Signing identity (`Developer ID Application`) is auto-detected from the login keychain. Notarization credentials come from env vars at `npm run pack:mac` time — `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` (app-specific password) or `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` (App Store Connect API key). With no credentials present electron-builder still signs but **skips notarization silently** (so local non-release packaging does not hard-fail).

---

## Distribution & auto-update

Devia is open source (Apache-2.0). The source lives in this repository
(`dherrero/devia-app`); the binaries are distributed from a separate public repo,
**`dherrero/devia`** (GitHub Pages landing + GitHub Releases). Installed apps
auto-update from that repo's Releases: **do not change `build.publish`
owner/repo, and do not move the landing's `updates/latest.json`** — every
shipped build points at them.

**Publish target.** `package.json` → `build.publish` is a single
`github` provider (`owner: dherrero, repo: devia`). electron-builder uses it to
generate the in-app `app-update.yml`. The CI uploads with a PAT
(`PUBLIC_REPO_TOKEN`, `contents:write` on `dherrero/devia`) because the default
`GITHUB_TOKEN` only reaches this repository.

**In-app updater** (`src/main/features/auto-update/`). `buildAutoUpdateFeature()`
wraps electron-updater's `autoUpdater` (`autoDownload` + `autoInstallOnAppQuit`).
It is a **no-op unless `app.isPackaged`** (dev has no `app-update.yml`, so a
check throws). On ready it checks after 10s and every 6h; updater events are
mapped to an `UpdateStatus` (`src/shared/domain/update.ts`) and pushed to the
renderer over the `update:status` event. The renderer (`AppComponent` +
`ElectronApiService.onUpdateStatus`) shows a toast: a passive "downloading"
notice on `available`, and a "restart to install" action toast on `downloaded`
(→ IPC `update:install` → `quitAndInstall`). IPC: `update:check` /
`update:install` / `update:status`. The updater is injectable
(`buildAutoUpdateFeature({ updater, isPackaged })`) for unit tests. **Linux:
auto-update only works for the AppImage target** — `.deb` users update manually
(a failed check is swallowed and surfaced as an `error` status, never a crash).

**Release pipeline** (`.github/workflows/`). `release.yml` bumps the version from
Conventional Commits and tags. `desktop-release.yml` runs after it via
`workflow_run`: a `gate` job skips the build when that version already has
installers in `dherrero/devia`; the `build` matrix (macOS/Windows/Linux,
`max-parallel: 1`) syncs `package.json` to the tag (electron-updater
compares it), runs `npm run build`, packages with `electron-builder`
and uploads the assets to the Release in
`dherrero/devia`; a final `manifest` job regenerates that repo's
`updates/latest.json` via `scripts/gen-update-manifest.mjs` (the integrity feed
the app verifies is `latest*.yml`, not this file).

**Repository secrets** (maintainers only): `PUBLIC_REPO_TOKEN`, `MAC_CSC_LINK`
(base64 of the Developer ID Application `.p12`) + `MAC_CSC_KEY_PASSWORD`, and the
notarization trio `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
Without the mac secrets the macOS job still builds but ships unsigned/unnotarized.
`DEVIA_SAAS_URL` is optional: unset, the upgrade deep link does nothing.

---

## Git workflow

GitHub Flow. Branch naming:

- `feat/<slug>` — new functionality
- `fix/<slug>` — bug fix
- `refactor/<slug>` — non-behavioral change
- `docs/<slug>` — documentation only
- `chore/<slug>` — tooling, deps, scripts

Hard rules:

1. **Never commit to `main` directly.** Check current branch before any edit; create a branch if on main.
2. **Never commit without explicit user confirmation** that the change works correctly.
3. **Never open a PR without explicit user request.**
4. **Push immediately after every commit** — the user reviews remotely; unpushed commits are invisible.
5. **Never bypass hooks** (`--no-verify`, `--no-gpg-sign`) without explicit user authorization.

---

## Filesystem persistence

All app data lives under `~/.devia-app/`:

| Path                                     | Content                                                  |
| ---------------------------------------- | -------------------------------------------------------- |
| `devia-app.config.json`                  | User configuration (workspaceRoot, agentId, theme, …)    |
| `state.json`                             | Runtime flags (newSession per project, toggles)          |
| `window-state.json`                      | Last window bounds + maximized flag (restored on launch) |
| `bases.json`                             | "New from base" templates                                |
| `sessions/<project>/session-<uuid>.json` | Chat history per project                                 |
| `projects/<key>/`                        | Session index per project                                |
| `outbox-archive/`                        | Files emitted by the agent                               |
| `attachments/`                           | Files attached in the composer / Telegram (any type)     |
| `tmp/mcp-<uuid>.json`                    | Ephemeral MCP configs (swept on startup, 24h TTL)        |
| `audit.log`                              | Tool-call audit trail (JSONL, rotates at 1 MiB)          |
| `mcp-servers.json`                       | Configured MCP servers                                   |
| `memory-global.json`                     | Devia internal memory — personal scope (S-1)             |
| `projects/<key>/memory.json`             | Devia internal memory — per-project scope (S-1)          |
| `projects/<key>/ui-confirmations.json`   | `devia_confirm` "always allow" grants (S-25 F2.4)        |

---

## IPC channel conventions

All channels live in `src/shared/contracts/ipc-channels.ts` as a const object:

```ts
export const IPC = {
  // Projects
  projectsList: 'projects:list',
  projectsCreate: 'projects:create',
  // Agents
  agentsList: 'agents:list',
  agentSelect: 'agent:select',
  // ... 40+ channels
} as const;
```

Never use string literals for channel names. When adding a channel:

1. Add to `IPC` in `ipc-channels.ts`.
2. Add the method signature to `devia-bridge.ts`.
3. Register the handler in `composition-root.ts`.
4. Add the typed wrapper to `ElectronApiService`.

---

## Agent layers — render ↔ core ↔ mappers ↔ CLI (S-30)

```
renderer ──[A: shared/contracts + AgentEvent]──▶ core (claude-runner) ──[B: AgentMapper]──▶ agents/<id> ──[C: wire.ts]──▶ CLI
```

Each agent is treated independently; the core is agent-AGNOSTIC.

- **Core** (`claude-runner/application/`) decides WHAT a run needs: mode, composed system prompt, Devia's + the user's MCP servers, UI tools, resume handle, memory, handoff, worktree. It builds an `AgentRunPlan` and never asks which agent it is. **Guard:** `core-is-agent-agnostic.test.ts` fails on any agent-id literal or concrete-mapper import there. `RunInteraction` owns every user-facing card of a run (devia-ui rendezvous, the agent's own dialogs, the kill timer, answer routing).
- **Contract B** (`agents/domain/`): `AgentMapper` in TWO phases, because the prompt may only announce what is delivered (S-25): `resolveDelivery(plan)` → `DeliveryResolution` (servers, skills/sub-agents channel, notices) → core composes the prompt → `prepareRun(plan, systemPrompt, delivery)` → `PreparedRun` (argv, `StdinPlan`, user `env` filtered by the def allowlist, trusted `agentEnv`, cleanup). After spawn, `openSession(io)` decodes the stream and owns ONE answer channel, `answer(callId, AgentAnswer)`; native dialogs come up as `AgentUiRequest`. `disallowedTools(mode)`, `harnessSupport`, `isolatesExternalMcp` are the mapper's metadata (the latter two reach the renderer as `DetectedAgentView.harness`).
- **Mappers** (`agents/<id>/`): `mapper.ts`, `wire.ts` (contract C: typed JSONL/RPC), decoder, golden tests over `__fixtures__/` recorded from the real CLI. Dedicated today: **claude, pi, opencode** (`DEDICATED_MAPPERS`); every other def runs on `LegacyMapper` (the exact pre-S-30 behaviour, checked byte-for-byte by `legacy-mapper.equivalence.test.ts` against a golden generated from the pre-refactor code). Shared building blocks: `agents/shared/def-invocation.ts` (argv/stdin from a def), `stream-session.ts`, `native-config-mcp.ts` (ONE write per run for native-config agents). Phase 2 (the other 10 agents) is spec **S-31**.
- **Launcher** (`cli-adapters/infrastructure/cli-launcher.ts`) only spawns a `PreparedRun`: binary, env (+ `PWD` = cwd — OpenCode resolves its project from `PWD`), Windows guards, watchdog, exit classification. It knows no prompt, system prompt or stream format.

**The harness travels through Devia (T-356).** Everything managed in Devia — MCP servers (bundled + MCP manager), skills, sub-agents — reaches whichever agent is active; the CLI's own config is not the source of truth. `HarnessCatalog` (core port) lists skills (the skills manager's reader: every agent's project + global dirs) and enabled sub-agents (`.devia/sub-agents`, parked = no `agents:` in the front-matter). `devia_skill` serves BOTH to any agent (repeatable `--skills-dir`, `--subagents-dir`; a sub-agent loads as a role). It is one tool on purpose: a new tool schema would sit in every turn's cached prefix (the ui-tools budget test). Mappers add native channels on top:

| | MCP (user + Devia) | Skills | Sub-agents |
| --- | --- | --- | --- |
| Claude | per-run `--mcp-config` (+ grants, `--strict`) | `.claude/skills` + `devia_skill` | native `--agents <file>` |
| pi | per-run `-e` extension (`registerMcpServer`) | native `--skill <dir>` each | `devia_skill` |
| OpenCode | per-run `OPENCODE_CONFIG` (never the repo's `opencode.json`) | `.agents/skills` + `devia_skill` | native `agent` entries in the per-run config |
| legacy agents | Devia's servers in their native config | `devia_skill` | `devia_skill` |

Per-run configs live in `<deviaDir>/tmp/`, owner-only, removed after the run: a user server's tokens must never be written into the user's repository. Opening the kanban board no longer writes agent config — every run delivers kanban through its mapper.

**Agent E2E harness** (`tools/agent-e2e/`, README there): drives real Claude / pi / OpenCode through the real pipeline (headless composition over `dist/main`), 4 scenarios (apply, resume, plan, harness), snapshots split into `wiring` (what reached the CLI — must not change) and `behaviour` (model-dependent, warns). Costs money, never in CI. grok is excluded: its MCP config is GLOBAL (`~/.grok/user-settings.json`) — anything delivering to grok writes the developer's real file, so sandbox `HOME` in scripts/tests.

**Adding an agent:** record fixtures with the harness → `wire.ts` → decoder + golden test → `mapper.ts` (+ tests) → register in `DEDICATED_MAPPERS` → snapshot it in the harness.

## Multi-agent support

Supported agents and their stream formats:

| Agent                   | ID                        | Format               | System prompt                     |
| ----------------------- | ------------------------- | -------------------- | --------------------------------- |
| Claude Code             | `claude`                  | `claude-stream-json` | `argv` (`--append-system-prompt`) |
| OpenAI Codex            | `codex`                   | `json-event-stream`  | `stdin-prepend`                   |
| Gemini CLI              | `gemini`                  | `json-event-stream`  | `stdin-prepend`                   |
| OpenCode                | `opencode`                | `json-event-stream`  | `stdin-prepend`                   |
| Cursor Agent            | `cursor-agent`            | `json-event-stream`  | `stdin-prepend`                   |
| GitHub Copilot          | `copilot`                 | `json-event-stream`  | `stdin-prepend`                   |
| Grok (grok-dev)         | `grok`                    | `json-event-stream`  | `argv-prepend`                    |
| Pi                      | `pi`                      | `pi-rpc`             | `argv-file` (`--append-system-prompt <file>`) |
| Qwen / DeepSeek / Qoder | `qwen`/`deepseek`/`qoder` | `plain`              | `stdin-prepend`                   |

**Grok (S-21).** `grok` drives the grok-dev CLI (Vibe Kit, `@ai-sdk/xai`) headless: `grok -p "<prompt>" --format json` emits a JSONL event stream (`step_start`/`text`/`tool_use`/`step_finish{usage}`/`error`, each line carrying `sessionID`). Continuity is **native** — the parser emits `session_started` from `sessionID`, and `buildResumeArgs` resumes with `--session <id>` against grok's SQLite store (`~/.grok/grok.db`), recovering full prior context. The prompt is delivered via argv (`-p`, no stdin) so the launcher guards `maxPromptArgBytes`; grok-dev exposes no `--system`/`--effort` flag, so the Devia system prompt is delivered via **`systemPromptStrategy: 'argv-prepend'`** (S-21 T-226) — the launcher inlines the same `[System] ... [User]` header used for stdin-prepend into the `-p` value (counted against `maxPromptArgBytes`, bumped to 200 KB for headroom). Auth: `GROK_API_KEY` or `~/.grok/user-settings.json.apiKey` (`probeGrokAuthStatus`). The S-21 def **replaces** the earlier degraded `grok-build` (xAI-official, plain text, no resume) — both share the `grok` binary, and the JSON parser falls back to plain text if an older `grok` ignores `--format json`. Parser: `parsers/grok-event-stream.ts`; matchers: `matchers/grok.matchers.ts`. **MCP (S-21 T-227):** grok-dev reads MCP servers ONLY from the global `~/.grok/user-settings.json` (`mcp.servers[]`, a nested array — not the standard `mcpServers` object), so the `grok-array` `McpSyncWriter` strategy injects `devia-memory`/`devia-kanban` there, keyed by their reserved ids (no `__devia_managed` field — grok validates the server schema). Because the file is global (grok has no project-scope MCP config), two Devia projects running grok concurrently race on the `--project` identity; the write happens immediately before spawn, so a sequential run is always correct.

**Pi (verified against pi 1.3.0 — its docs ship in `~/.pi/agent/install/releases/<v>/node_modules/@earendil-works/pi-coding-agent/docs/`).** `pi --mode rpc` is a bidirectional JSONL session driven by `agents/pi/rpc-driver.ts` (`prompt` + `get_state` commands, events back; contract in `agents/pi/wire.ts`). Gotchas that each broke a Devia feature:
- **The turn ends on `agent_settled`, NOT `agent_end`.** `agent_end` closes one low-level run; retries, overflow recovery, compaction and queued messages can still follow, and closing stdin there cut them off.
- **MCP is delivered by a per-run extension, never `.pi/mcp.json`.** pi reads the project file only in TRUSTED projects (`~/.pi/agent/trust.json`) and RPC mode cannot ask, so session worktrees silently lost every Devia tool; `--approve` would also load any extension the repo ships. `agents/pi/pi-mcp-extension.ts` writes `<deviaDir>/tmp/pi-mcp-<uuid>.mjs` calling `pi.registerMcpServer()` for the user's AND Devia's servers, passed as `-e <file>` — the counterpart of Claude's `--mcp-config`. A `.pi/mcp.json` entry OVERRIDES a registration with the same name, so every pi run strips Devia-managed entries from it (`retirePiProjectMcp`, deletes the file when nothing else is left). `devia-ui` is registered with `timeout: 360` (pi's MCP default is 60 s; blocking cards wait up to 5 min). Every Devia skill also goes natively as `--skill <dir>`.
- **Tool names are sanitised:** `mcp__<server>__<tool>` with non-`[A-Za-z0-9_]` → `_` (`mcp__devia_ui__devia_todo`). The renderer keys on `mcp__devia-ui__…` (icons, `tool-display.ts`), so the driver restores the ids of every server the run registered (`normalizePiToolName`). Stdout of every agent is decoded with a `StringDecoder` — a multi-byte character can straddle two chunks.
- **Continuity is native:** `get_state.sessionId` → `session_started`; the next turn passes `--session-id <id>` (reopens, or creates if deleted). No replay.
- **Plan mode** = `--tools read,grep,find,ls,mcp__*`. pi has no permission modes; excluding only `edit`/`write` is not enough (the model wrote with `bash echo >`), and `mcp__*` is required because an allowlist drops every MCP tool no entry matches.
- **Usage:** `turn_end.message.usage` = `{input (excl. cache), output, cacheRead, cacheWrite, cost.total}` per assistant response; the driver emits tokens of the LAST response, `cachedInputTokens = cacheRead + cacheWrite`, cost ACCUMULATED over the run (the renderer keeps the last `usage` event), and `contextWindow` from `get_state.model`. Extension-UI dialog fields (`title`, `message`, `options`) are top-level on `extension_ui_request`. `exposure` (`direct`/`codemode`/…) is a pi-only server field: the JSON writer emits it only for pi targets (Grok/Codex validate their schemas).

**Usage events feed the footer context bar — gotchas.** Context fill = `inputTokens + cachedInputTokens` of the LAST API request, so every parser must emit `inputTokens` EXCLUDING cache (Anthropic's split; Codex's `cached_input_tokens` is a subset of `input_tokens` and is subtracted). Claude's `result.usage` top-level counters are the SUM of every request in the run (≈9× the real context on a tool-heavy turn) — only `usage.iterations[-1]` is a context size; the window comes from `modelUsage[<run model>]` (Haiku side-calls also appear there with 200k). Every usage field must also survive persistence: `PersistedAgentEvent` (`src/shared/domain/persisted-agent-event.ts`) is what messages are rebuilt from on load, and it used to drop `cachedInputTokens`/`contextWindow` — after a reload the bar fell back to the static 200k table (`claude-default`) and read 5× too high while the next turn streamed.

Non-CLI providers (API, MCP, local-model, planned) are registered for UI visibility but cannot be selected as the active agent — `SelectAgentUseCase` rejects them.

User-configured MCP servers (from the manager) and Devia's bundled servers (`devia-memory` gated on `memory.enabled`, `devia-kanban`, `devia-ui`) reach each agent through its mapper — see "Agent layers" above. The bundled-server builders (`MemoryMcpInjector` / `KanbanMcpInjector` / `UiMcpInjector`, names historical) only build `McpServerConfig`. Native-config delivery writes all of Devia's servers in ONE write per run (`NativeConfigMcpDelivery`, `prune: false`); the MCP-manager catalog sync (`prune: true`) never prunes `BUNDLED_SERVER_IDS` unless listed in `removedIds` — together these stop the old bug where each injector deleted the server the previous one wrote. Every delivery retires the dead S-24 `devia-ask` entry (only entries with the `__devia_managed` marker — a hand-added one is respected). Known: Gemini CLI 0.46 rejects that marker key (S-31 T-357). An agent that cannot load MCP while the user configured servers gets a status notice (UC-FIX-005).

**Auto-continue after the usage limit (Claude Code).** Settings → Execution → Claude has an "Auto-continue sessions" switch (`config.autoContinueSessions[agentId]`, default off). Claude's decoder turns a `rate_limit_event` with `status: 'rejected'` into an `AgentEvent` `rate_limit` (`resetsAt` in epoch **ms**; the wire value is seconds; `allowed` is silent, `allowed_warning` → `warning`) and classifies the run's error `result` as `transient`. `RunInstructionUseCase` remembers a rejection and calls `handlers.onRateLimited` right before `onProcessEnd`; `claude.ipc.ts` then asks `AutoResumeScheduler` (`claude-runner/application/`) to continue the session at `resetsAt` + 30 s by calling `submitInstruction` with the SAME mode/origin/runKey/sessionId and a fixed "Continue where you left off." prompt (native resume carries the context). Rules that each exist for a reason: deadlines are polled against the wall clock (15 s) and re-checked on `powerMonitor('resume')`, because a `setTimeout` does not advance while the machine sleeps; waits up to 8 days are scheduled, so the weekly window is resumed too (the banner shows the date when it is not today; the app must stay open meanwhile); at most 3 resumes in a row that hit the limit again (`noteCleanRun` resets the streak); the queue is NOT dispatched while a resume is pending (parked items would hit the same limit); a user message, Stop, session reset, agent switch or switching the option off cancels it (checked again when it fires). The renderer shows `ds-auto-resume-banner` (above the queue panel) from `AppStateService.autoResumes`, fed by `autoresume:scheduled` / `autoresume:cancelled`, with a Cancel button (IPC `autoresume:cancel`). Memory only: a pending resume does not survive closing Devia. **Detection** (shapes recorded from real sessions, Claude Code 2.1.302): a hit limit is a synthetic assistant message (`model: "<synthetic>"`, text "You've hit your session limit · resets 11:30am (Europe/Madrid)", `error: "rate_limit"`, `apiError: "usage_limit_reached"`, window under `apiErrorParams.rate_limit_info = { status: "rejected", resetsAt (seconds), rateLimitType: "five_hour" }`); the decoder also accepts a standalone `rate_limit_event` and, as a last resort, the error `result` text (`limit-text.ts` parses "resets 11:30am (Europe/Madrid)" into a timestamp). The decoder reports it once per run. **Unverified:** those shapes come from the session transcripts on disk; the exact stdout stream lines in `-p` mode have no recorded fixture yet, which is why every one of the three sources is handled.

---

## UI tools — the `devia-ui` MCP server (S-25)

**Why it exists.** Claude Code **2.1.220 removed `AskUserQuestion` from headless (`-p`) runs**, which is the only mode Devia drives — confirmed against a bare `claude -p --output-format stream-json --verbose`, whose `system/init` `tools` array does not list it (no Devia flag is involved). The question card simply stopped appearing. MCP tools DO reach a headless run, so Devia serves the card as its own tool. **Do not "restore" the PreToolUse hook**: there is no tool left to intercept. S-24 shipped that as `devia-ask` (now deleted); S-25 generalises it to every interface tool, and every supported agent gains them — not just Claude. **Verification status:** the 8-CLI × 8-tool matrix (`docs/ui-tools/01-cross-agent-matrix.md`) and the context-cost measurement (`02-context-cost.md`) were NOT run; the owner verifies through daily use. Treat a per-CLI misbehaviour as plausible, and use those docs as the procedure when diagnosing one.

**ONE server, not eight.** Each MCP server costs a process spawn per run AND its tool schemas in the CACHED PROMPT PREFIX on every turn. Devia already paid that bill twice (S-16 T-188 empty-board kanban gating, T-189 dropping `Workflow`). `devia-ui` centralises the rendezvous, the delivery gate, the plain-text fallback protocol and the tool registry. **Adding a tool must not mean adding a server.**

**The surface.** `src/main/features/ui-tools/`: `mcp-server/tool-registry.ts` (a tool definition is DATA — schema, description, blocking kind), `ui-tools-call.ts` (the one uniform behaviour), `ui-server.ts` (JSON-RPC dispatch), `server.ts` (stdio entry), `ui-mcp-injector.ts` (the server config; each agent's mapper delivers it), `infrastructure/confirmation-store.ts` (the F2.4 grants).

| Tool | Kind | Offered in |
| --- | --- | --- |
| `devia_ask_user` | blocking | plan + apply |
| `devia_todo` | fire-and-forget | plan + apply (and remote) |
| `devia_plan_approve` | blocking | **plan only** |
| `devia_request_review` | blocking | apply only |
| `devia_confirm` | blocking | apply only |
| `devia_pick` | blocking | apply only |
| `devia_notify` | fire-and-forget | apply (and remote) |
| `devia_skill` | resolved locally | wherever the project has skills (and remote) |
| `devia_send_file` | fire-and-forget (validated locally, then forwarded) | plan + apply + apply-yolo, ONLY when `canSendFiles` (remote, or desktop with `mirrorDesktop`) |

**The rendezvous.** The server cannot call the main process, so they meet on disk in a **per-run** directory, `os.tmpdir()/devia-ui/<runId>` (contrast: `devia-memory`/`devia-kanban` are keyed per PROJECT). Helpers in `src/main/shared/ui-rendezvous.ts`:

1. `tools/call` writes `<callId>.request.json`, carrying a **`tool` discriminator** and an `expectsAnswer` flag, and — for a blocking tool — polls for the answer;
2. the runner runs ONE poller over the directory every 100 ms and multiplexes on `request.tool`;
3. the user's resolution comes back through `writeToolResult`, which writes `<callId>.answer.json` as `{ answer }`;
4. the server returns that text as the tool result and deletes both files.

A fire-and-forget request is swept by the runner as soon as it is consumed, or the poller would re-emit it every 100 ms for the rest of the run. An advertised-but-unhandled BLOCKING request is answered rather than left to hang.

**Each request is handled ONCE (S-28 T-333, do not remove).** A BLOCKING request file stays on disk until the server reads the answer, so the poller sees it on many ticks. The generic handler guards on `seenToolUseIds` (callIds are `ui-<uuid>`, so they never collide with stream `tool_use` ids). Without the guard, every 100 ms tick re-emitted `ui:tool-request` (an answered card came back with live buttons and could never be resolved), re-armed the `QUESTION_TIMEOUT_MS` kill (so it NEVER fired for confirm/pick/plan_approve/request_review) and wrote an audit entry. The renderer adds a second guard: `UiToolsService` keeps a per-session set of settled callIds and refuses to redraw one.

The dispatch is async and the readline loop does not await it, so a tool pending for minutes never stops the server from serving other messages, and several can be live at once. **Two timeouts, on purpose:** the server's own (returns `isError` with instructions to carry on) and the runner's `QUESTION_TIMEOUT_MS` kill, which is the real safety net against a hung run. Only BLOCKING tools arm it — a status card must never be able to kill a run because nobody "answered" it.

**The gate.** `uiTools = { delivered, advertised }`, resolved BEFORE the system prompt is composed, because the prompt has to either announce each tool or teach its plain-text equivalent, and getting that wrong is worse than either branch. The **set is computed first and delivery second**, because the server's argv carries the set (`--tools a,b,c`). It must be deterministic for the whole run or the cached prefix changes mid-conversation.

`delivered` is false for: an enterprise-managed MCP config (T-88 forbids `--mcp-config`), an agent with no MCP target (deepseek/qoder/mimo), a failed native-config write, and an empty tool set. **A remote (Telegram) run is NOT undelivered** — it keeps the non-interactive tools (three, or four with `devia_send_file`) and loses the rest, which is the policy's job, not the gate's.

**Policy** (`src/shared/domain/ui-tools-policy.ts`, pure): `resolveAdvertisedUiTools` describes INTENT per mode; `wiredUiTools` narrows it to `IMPLEMENTED_UI_TOOLS`, i.e. the tools the RENDERER can draw a card for — advertising a blocking tool with no card hangs the run until the kill timeout. A user preference (`config.uiTools.enabled`) can only NARROW, never widen: enabling `confirm` in settings must not surface it in plan mode.

**The execution panel (S-28).** `ds-ui-tool-host` is NOT a stack of cards. It has exactly one of three shapes: **proposal** (a pending `plan_approve` — only its card), **executing** (the run has a step list — a read-only `dv-stepper` from `libs/ui`, collapsed to one line, that opens by itself when a step needs an answer and draws the `confirm`/`pick` card INSIDE the active step; once answered the card becomes a one-line note on that step and the panel folds back), and **loose** (no step list — the waiting card alone). `devia_todo` is no longer drawn as a card above the composer: it feeds the stepper, and it is still upserted into the thread as `kind:'todo'`. State lives in `UiToolsService.executionStates` per session: `steps`, `notes[stepId]`, and `carryOver`. `carryOver` covers one transition: "approve and run" seeds the steps from the plan at once, but the PLANNING run ends right after, and the run-end clear (an effect on `runningPaths` that empties a session's panel when its run stops) would wipe them before the follow-up run publishes its own list — a carried-over state survives exactly one run end. Each request records the step that was current when it arrived (`PendingUiTool.stepId`), which is where its note lands. `devia_request_review` is not in the panel: the Cambios view is its card, and an EMPTY diff answers by itself (`nothingToReview` → decision `empty`) because the review bar only exists for a non-empty diff.

**Plan steps and the decided plan (S-28).** `devia_plan_approve` takes optional `steps` (strings, max 20 × 200 chars, renumbered `step-1..n` by the normalizer whatever the agent passed). `buildPlanFollowUpPrompt` then tells the agent to publish `devia_todo` with exactly those ids and to mark them as it goes — that is the contract between the plan and the stepper. Every decision (approve, approve-and-run, reject + reason) is appended to the thread as `kind:'plan'` with a `PlanRecord` (`UiToolsService.resolvePlan` answers the agent FIRST, then appends, then the host emits the follow-up, so the thread reads in order); `ds-plan-message` renders it collapsed and without buttons.

**Design tokens gotcha.** The S-25 cards were written against Material-style names (`--dv-on-surface`, `--dv-surface-container`, `--dv-outline`, `--dv-on-acc`, `--dv-error`) that DO NOT EXIST in this design system; they silently resolved to nothing (transparent backgrounds, inherited text). The real ones are `--dv-fg`, `--dv-muted`, `--dv-surf`/`--dv-surf-2`/`--dv-surf-3`, `--dv-bor`, `--dv-divider`, `--dv-acc-fg`, `--dv-danger*` (renderer `styles.scss` + `libs/styles`). `tools/check-scss-tokens.ts` does NOT catch this (it checks raw px/hex only, and is not wired to any hook).

**The answered-question record in the thread.** `devia_ask_user` answers survive in the transcript as `ds-question-answered-card`, keyed on the TOOL NAME via `isAskUserTool()` (`src/shared/domain/question-ask.ts`: `AskUserQuestion`, `mcp__devia-ui__devia_ask_user`, the S-24 `mcp__devia-ask__…`, OpenCode's `devia-ui_devia_ask_user`) — matching only `AskUserQuestion` buried every answer as a generic tool card. The card is keyed by the rendezvous callId (`ui-<uuid>`), never the stream's `tool_use` id, so `answerQuestion` re-keys its optimistic `tool_result` onto the run's latest unanswered question tool call (`transcriptQuestionId`). That optimistic result is the ONLY record for Claude: its decoder drops `user` lines, so tool results never come back over the stream. A finished run's question with no result still renders (question + "Respuesta no registrada") — Claude sessions saved before this fix.

**Adding a tool** is: a schema in `tool-registry.ts`, a case in `ds-ui-tool-host`'s `#cardList` template plus its name in that component's `CARD_TOOLS` (if it draws a card), its name in `IMPLEMENTED_UI_TOOLS`, and its i18n keys. Two test assertions then need updating — `wiredUiTools > drops a tool whose card has not landed yet` and `passes the advertised tool set to the server` in `run-instruction.use-case.test.ts`.

**An agent that cannot reach the user interactively must still know how to** — plain text, numbered options, end the turn, the user replies in the next message of the same session — otherwise it goes silent or invents an answer. `infrastructure/ui-tools-protocol.ts` holds both halves: `buildUiToolsHint` announces what the run HAS, `buildUiFallbackHint` covers what it LACKS. They are exact complements. Only the four decision-carrying tools (`ask_user`, `plan_approve`, `request_review`, `confirm`) generate fallback text; `todo`/`notify`/`pick`/`skill` are conveniences and a paragraph about their absence would cost context and buy nothing. **Exception (S-32 T-368):** when the run can send files (`canSendFiles`) but `devia_send_file` was not delivered, the fallback adds one line pointing at `outbox/` (relative, so the prompt stays cache-stable across worktrees) — or, in plan mode, saying files can't be sent. `buildRemoteProtocolHint(isRemote, filesReachable)` adds one "send it as a file" bullet, no mechanics. Without a relay both outputs are byte-identical to before (tested).

**Gotcha:** `trackedHandle.writeToolResult` used to exist only for CLIs that keep a stream-json stdin open (Claude). Since the answer travels by FILE, it is mounted whenever anything was delivered, or an agent without that channel would have nowhere to receive the user's click.

**`devia_plan_approve` and the mode switch.** "Approve and run" CANNOT change the mode of the run in flight: the sandbox and permission flags (`--permission-mode`, `--sandbox`, `--dangerously-*`) are fixed in the argv of the already-spawned process. So the tool result tells the agent to END ITS TURN, Devia switches the session to `apply`, and queues a follow-up instruction (`buildPlanFollowUpPrompt`, plan inlined verbatim so the next run does not depend on the agent remembering it). `submitInstruction` parks it because the agent is still busy, and the runner dispatches it the moment the turn ends.

**`devia_confirm` grants.** `projects/<key>/ui-confirmations.json`, keyed by the BASE checkout (a per-session worktree path would fragment them — the S-1 lesson). Matching is by **EXACT equality of the normalised action**, never by prefix or pattern: `rm -rf node_modules` must not authorise `rm -rf /`. An action the agent flagged `danger` never offers "always". The store deliberately has no cache: a stale "granted" would auto-approve something just revoked.

**`devia_send_file` (S-32) — the agent sends a file to the remote chat.** Fire-and-forget: the tool returns `Queued: <name> (<size>) will be sent … after your reply` and the file goes out after the text reply (see the `telegram-controller` row). Offered in plan, apply and apply-yolo, remote or desktop-mirrored, ONLY when **`canSendFiles` = relay connected (`remoteRelayConnected`, read once per run) && (`isRemote` || `remoteControl.mirrorDesktop`) && `remoteControl.allowFileSend !== false`** (default `true`, read per run so no bot restart). `canSendFiles` is opt-in in the policy (`resolveAdvertisedUiTools`): absent = off, so a run without a relay advertises exactly what it did before. Schema is kept bare (`path`, `caption?`, `as?: auto|document|photo`): +438 chars on the `tools/list` payload — apply 4 207 → 4 645 (cap 4 800), remote apply 1 395 → 1 833, whole surface 5 420 (cap 5 500). **Plan mode keeps it on purpose** (sending an existing file is read-only, and "send me that report" is the main remote use case): plan 3 056 → 3 494, under its own cap `planWithSendFile` 3 600 instead of bending `plan`'s.

- **Two validations, same guard.** `checkOutboundFile` (`src/main/shared/outbound-file-guard.ts`, Node-only, no Electron) runs FIRST inside the server via `resolveLocally` (`send-file-resolver.ts`) — a fire-and-forget refusal noticed only by main would never reach the agent, which would believe the file left. A resolver may now return `{ passThrough, ack }`: the call still goes to the rendezvous, with the ENRICHED request (`absPath`, `name`, `size`, `mime`) as `toolInput`. Main then **revalidates** in `RunInteraction` through the run's `RunFileGate` (`src/main/shared/outbound-file-gate.ts`): it never trusts `absPath`/`size`/`mime` from the request file (it sits in a tmp dir the agent can write), re-runs the guard and builds the `RunFile` from ITS result, including the validated `identity` (`dev`/`ino`) the uploader re-checks. A request main refuses (changed since the server's check, the per-run limit, a hand-written request…) is audited `rejected:<reason>` AND published as `file_rejected` (`source: 'tool'`) through `onRunFileRejected`, because the agent was already told "queued": it shows up in the chat's `⚠️ No pude enviar` message. `RunInteraction.stop()` does one last `fireAndForgetOnly` poll pass before the rendezvous dir is removed, so a request written in the poller's final 100 ms still reaches the relay ahead of `end`. `claude.ipc.ts` publishes the admitted `RunFile` as a `file` event on the `RunGateway` and the renderer appends it to the thread as an `outbox` message with `channel: 'telegram'` (badge "Para Telegram" / `chat.outbox.for_telegram`, with a `for_telegram_hint` tooltip — NOT "sent": main only accepted the file, the upload happens after the run and can still fail or be skipped on a stop). The outbox fallback goes through the SAME gate (see the `outbox` row), and the per-run limit (`UI_LIMITS.sendFilesPerRun` = 10) counts both channels in main.
- **Roots.** `sendRoots = [config.workspaceRoot]` plus the run's cwd ONLY when it is a validated live session worktree (`isLiveSessionWorktree`) and not the project checkout. The attachments dir is never a root; apply-yolo widens nothing.
- **argv.** `--send-roots <json array>`, `--cwd <abs>` (explicit: pi/OpenCode may spawn the server elsewhere) and `--deny-roots <json array>` (Devia's data dir, `config.deviaDir()`) are emitted by `UiMcpInjector` ONLY when `send_file` is advertised, so every other run's argv stays byte-identical.
- **Limits.** Constants in `src/shared/domain/outbound-file-policy.ts`: `MAX_UPLOAD_BYTES` 50 MB (bot API), photos over `MAX_PHOTO_BYTES` 10 MB or non-jpeg/png/webp images go as documents, caption ≤ `MAX_CAPTION_CHARS` 1 024 chars, `MAX_MEDIA_GROUP` 10; path ≤ 4 096 chars (never clamped: a truncated path names a different file), regular files with a single link only.
- **Prompt.** `buildUiToolsHint` announces the tool; the `outbox/` fallback line (`buildUiFallbackHint`) only when `canSendFiles` but the tool was not delivered (see the fallback paragraph above).

**Security gotcha — `devia_send_file` is an exfiltration channel. Never relax it.** It uploads bytes from this machine to Telegram's servers on the agent's say-so. The defences are layered on purpose: (1) roots (workspace + this run's live worktree only); a root equal to or above the home folder (`isRootTooBroad`) is dropped, and if none is left the request is refused `home_root`; (2) deny roots — anything under Devia's data dir (transcripts, memory, attachments, outbox archive) is refused `devia_data` even when the workspace contains it, except a live session worktree nested inside it (most specific wins); (3) the denylist `SECRET_PATH_PATTERNS` in `src/shared/domain/outbound-file-policy.ts` (`.env*` incl. `.envrc`, `*.env`, `.dev.vars`, `.ssh/`, `.aws/`, `.config/gcloud/`, `gh/hosts.yml`, keys/certs incl. `id_dsa*`/`*.ppk`/`*.p8`, keychains, `kubeconfig*`, `*credentials*`, `*.tfvars`, `.vault-token`, `.my.cnf`, `.s3cfg`, `.terraformrc`, `*_history`, `.npmrc`, `.git/`, `.claude/settings*.json`, `devia-app.config.json`, `terraform.tfstate*`…), matched per path segment on the part INSIDE the workspace, case-insensitive; (4) `realpath` — containment, deny roots and denylist are re-checked on the REAL path, so a symlink inside the workspace pointing out of it (or at a secret) is refused; lexical containment is checked first so a path outside the roots is refused without revealing whether it exists; `lstat` on the real path and `nlink > 1` is refused `hardlink` (a hard link is the secret's inode under an innocent name); (5) revalidation in main (`RunFileGate`) before anything is published; (6) the upload-time re-check on the open handle (`O_NOFOLLOW`, `fstat`, single link, same `dev`/`ino` + size — see the `telegram-controller` row), so nothing swapped in between admission and upload leaves. The denylist is a **code constant, not a setting** — a config entry could be edited by the very agent it restrains; `allowFileSend` only turns the whole feature off. Audit entries carry name + size only, never content or absolute path; `describeError` strips paths/tokens from failure reasons shown in the chat.

**`devia_skill`** resolves inside the server process against disk (`--skills-dir`), not through the rendezvous — it is a read-only file lookup that needs nothing from main. Guards: name limited to `[A-Za-z0-9_.-]`, resolved path re-checked inside the root, `lstat` + symlink rejection (same guard as the prompt-pack scanner), 256 KiB cap with explicit truncation. Measured during S-25: replacing `buildSkillRegistryHint` with this tool does NOT pay off — that hint is already a ~340-char pointer to the registry, not a listing.

**Conversation continuity (S-19).** `RunInstructionUseCase` sends only the latest instruction and relies on native CLI resume (`agentSessionId`, captured from `session_started`). Agents whose CLI exposes no clean resume handle declare `RuntimeAgentDef.continuity: 'replay'` (today **gemini**; pi resumes natively with `--session-id`, OpenCode with `run --session <id>` since S-30; default `'native'` for everyone else, no migration). For a `'replay'` agent the runner re-seeds the prior transcript into the user prompt via `buildConversationReplay()` (`src/shared/domain/conversation-replay.ts`, budget `replayBudgetChars`), skipped when a cross-agent handoff brief already carries the tail or on the first turn. Native-resume agents get a byte-identical prompt — replay is fully additive. Gemini/OpenCode parsers map their full verified event shapes (usage/cost/error/tool_result) and have `authProbe`s; wire DTOs live in `parsers/wire/`, shared JSON helpers in `parsers/json-util.ts`.

**Whole-workspace visibility (`--add-dir`).** Every run in a **confined mode** (`plan` / `apply`) is granted read/write access to the whole `config.workspaceRoot`, so a project can reference sibling projects in the same workspace without per-project consent. `RunInstructionUseCase` populates `AgentRunRequest.extraAllowedDirs = [cfg.workspaceRoot]` (gated on `requestedMode !== 'apply-yolo'`); `LauncherBackedAgentRunner` forwards it to `CliRunRequest.extraAllowedDirs`, and each adapter's `buildArgs` turns it into `--add-dir <workspaceRoot>` for the agents that support it (Claude — gated on the `--add-dir` capability; Codex — fresh runs only, `exec resume` keeps its recorded cwd; also copilot/qoder; pi has no sandbox, so it needs no flag). **`apply-yolo` omits it** — that mode already runs without sandbox/path confinement (`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`), so the extra dir would be redundant. **Gemini** maps `extraAllowedDirs` onto `--include-directories` (comma-joined), capability-gated like Claude's `--add-dir` (S-19 F2.2). **OpenCode** has no per-path CLI flag and stays cwd-confined — granting it sibling dirs needs a `permission.external_directory` write to its native config (not yet done; tracked in S-3). Blast-radius note: under `apply` (Claude `acceptEdits`, Codex `workspace-write`) this auto-approves edits across every workspace project, not just reads.

**`Workflow` tool gating (S-16 T-189).** Claude Code's built-in `Workflow` tool (deterministic multi-agent orchestration) carries a large (~4.5k-token) schema that sits in the cached prompt prefix on every turn. It only earns its cost for the deep research/analysis that **plan** mode is for, so `RunInstructionUseCase` adds `Workflow` to Claude's `--disallowedTools` (via `capabilities.disallowedTools`) for every mode EXCEPT `plan` (i.e. dropped in `apply` / `apply-yolo`, the task-execution modes that run many turns via the kanban). plan also blocks file-writers, so only analysis-style workflows make sense there anyway. Confirmed empirically: `--disallowedTools` excludes the tool's *definition* from the request (not just its use), so this saves ~4.5k tokens/turn (~30% of total context) in apply/yolo. Claude-only (the tool is a Claude Code built-in).

Devia has no interactive permission approver in its headless `-p` runtime, so for Claude **every MCP server Devia manages is auto-approved by persisting the grant to the project's `.claude/settings.local.json`** — the single source of truth for MCP permission, NOT a per-run `--allowedTools` flag. Claude re-reads the settings file on every `-p` invocation, so the grant takes effect on the next (and current) turn. `grantClaudeMcpAccess()` / `revokeClaudeMcpAccess()` in `src/main/shared/claude-defaults.ts` upsert `permissions.allow += "mcp__<id>"` (whole-server approve) and, for project-scope `.mcp.json` servers, `enabledMcpjsonServers += "<id>"` (headless trust). The write is surgical: it never expands non-MCP permissions and leaves a malformed file untouched. Two call sites, non-overlapping:

- **`RunInstructionUseCase`** writes `permissions.allow` for the servers it delivers via `--mcp-config` (the user-enabled global servers from the MCP manager + Devia's own `devia-kanban`). `--mcp-config` servers are auto-trusted, so they need no `enabledMcpjsonServers` entry.
- **`InstallMcpUseCase`** writes `permissions.allow` + `enabledMcpjsonServers` for **project-scope** servers (which are NOT in the runtime registry and only load from the project `.mcp.json`); `RemoveMcpUseCase` revokes them. Global-scope servers need nothing here — the runner grants them.

Enabling a server in the manager is the consent step. Servers Devia did NOT add to its registry (e.g. hand-edited `.mcp.json` entries) are not auto-allowed (we add specific ids to `enabledMcpjsonServers`, never `enableAllProjectMcpServers`). This is also what lets the SDD planner's `kanban_*` tools run in plan mode. Other (non-Claude) agents already run fully permissive at runtime — Gemini `--yolo` + `GEMINI_CLI_TRUST_WORKSPACE`, OpenCode `--dangerously-skip-permissions`, Codex `exec --sandbox` — so once the server definition is written to their native config (`KanbanMcpInjector` / `McpSyncWriter`, #272) their tools auto-approve with no extra permission file. Cursor/Copilot have no yolo flag and their headless trust mechanism is unverified (pending).

---

## Devia-native SDD kanban — MCP tool surface (E-DSK-12, S-12)

The `devia-kanban` MCP server (`src/main/features/sdd/mcp-server/`) exposes the board to the active CLI agent. `KANBAN_TOOLS` (in `kanban-tools.ts`) is the full surface; `callKanbanTool` dispatches to `KanbanUseCase` / `KanbanStore` over the per-project `kanban.json`. Board mutations are reflected into the UI by `KanbanWatcher` (the server process owns no hooks).

**Empty-board tool gating (S-16 T-188).** `tools/list` advertises the FULL surface only when the board has content; on an empty board (0 specs, 0 tasks) it advertises just the two bootstrap tools (`kanban_create_spec`, `kanban_create_task`) via `advertisedKanbanTools(boardIsEmpty)`. Rationale: the server is injected for EVERY Claude run (the SDD planner needs `kanban_*` even in plan mode), so a project that never touches the kanban would otherwise pay ~2k tokens of tool schemas in the cached prompt prefix every turn. `callKanbanTool` still dispatches the full set, so nothing is lost — the agent can always start a board, and the full surface returns automatically on the next run once a spec/task exists (one prefix change at that transition).

**Board-ergonomics tools (S-12):**

- `kanban_list` is **paginated + filtered**, not a full dump. Params: `specId`, `column`, `includeArchived`, `verbose`, `limit` (default 30), `offset`. Returns `{ specs: KanbanSpecSummary[], tasks: KanbanListCard[], total, offset, limit, hasMore }`. Task cards are **lightweight by default** (no `body`); `verbose: true` adds the body. Use `kanban_get_task` for one task in full.
- `kanban_list_specs` — the cheapest "what specs exist / where are we?" query: spec summaries with per-column task counts, no tasks/bodies.
- `kanban_update_task` (T-139) — edit `title` / `body` / `specId` / `dependsOn` after creation. Editing `dependsOn` re-runs the dependency block state via `KanbanUseCase.reconcileDependencyBlock`: clearing the last unmet dep unblocks the task to its previous column; adding an unmet dep blocks a live task (mirrors `createTask`). Self-references and unknown ids are dropped; an unresolvable `specId` is ignored. `KanbanTask.specId` is therefore mutable.
- `kanban_archive_spec` / `kanban_reopen_spec` (T-140) — **logical-delete** of a spec via `KanbanSpec.archivedAt`. Archived specs (and their tasks) are hidden from `boardView` / `listBoard` / `specSummaries` (hence from the UI and every list tool) unless `includeArchived: true`; the data is kept on disk and reopen is the inverse. `archive` refuses a spec with open (non-`done`) tasks unless `force: true`.

The renderer hides archived specs automatically because `boardView` (the source for `kanban:board` + `kanban:changed`) excludes them by default — no renderer-side filtering needed. The UI's `kanban:update-task` IPC forwards `specId` too (`sanitizeFields`). **Archive has a UI consumer (`kanban:archive-spec`):** when the board filter is narrowed to a single spec and every one of its tasks sits in `done`, the Kanban board's second toolbar bar shows a "Spec finalizado · [Cerrar spec]" affordance (`KanbanModalComponent.finishedSpec` computed) with an inline two-step confirm that calls `archiveSpec` (logical-delete). The handler delegates to `KanbanUseCase.archiveSpec`; the board self-refreshes via the `onChange → kanban:changed` hook and the spec filter falls back to "all specs". **Reopen stays MCP-only** (no UI consumer).

---

## Devia internal memory + engram integration (S-1)

Devia ships its **own** persistent memory, modelled 1:1 on the bundled `devia-kanban` MCP server. The feature lives in `src/main/features/memory/` and is gated by `config.memory` (`{ enabled, blockEngram, engramImported, engramImportedAt? }`, defaults `enabled:true, blockEngram:true`).

**Storage** — JSON, mirroring `KanbanStore` (no native deps, no embeddings). `MemoryStore` writes `~/.devia-app/memory-global.json` (personal scope) and `~/.devia-app/projects/<key>/memory.json` (project scope), atomic temp+rename, in-memory cache, defensive parser. Lexical search (token-overlap scoring, title boosted ×3).

**Project identity = BASE checkout, never the run cwd (worktree fragmentation fix).** `RunInstructionUseCase` keeps two paths: the effective run `cwd` (for an isolated pane, a per-session worktree `<deviaDir>/worktrees/<projectKey>/<sessionId>`) and `projectCheckout` (`cwdResult.resolvedPath`, the base checkout). ALL memory + kanban project identity flows through `projectCheckout`: `memoryMcpServer`/`kanbanMcpServer` (the `--project` argv of both bundled MCP servers), `memoryContext`, `saveMemoryPrompt`/`saveMemorySummary`/`saveMemoryHandoff`, `recentHandoffSummary`, and the non-Claude injector `injectMemoryMcp(agentId, configProjectAbs, memoryProjectAbs)` — the native config FILE still lands at the cwd (the CLI reads its project config from where it runs), only the `--project` identity is the base. Keying by the worktree cwd derived a `MemoryStore.keyForPath` key unique per session (the path embeds the sessionId), fragmenting memory into one orphan `projects/<worktree-key>/memory.json` per session — a `mem_save` in one session was invisible to `mem_search` in every other session and to the Settings panel. Per-run concerns that MUST stay on the effective cwd: `grantClaudeMcpAccess` (Claude reads `.claude/settings.local.json` from its cwd), `buildSkillRegistryHint`, `detectExternalMemory` (the `.mcp.json` the agent actually loads), `ensureCodexTrust`. A startup migration (`infrastructure/worktree-memory-migration.ts`, run once per launch in `buildMemoryFeature.register`) folds orphan worktree-keyed stores back into their base project store (ids re-sequenced onto the base counters, original file renamed `memory.json.migrated` for idempotence/recovery). Orphan `kanban.json` files from the same bug are NOT migrated (merging board ids is unsafe); the identity fix stops new ones.

**`devia-memory` MCP server** — `src/main/features/memory/mcp-server/server.ts`: stdio JSON-RPC 2.0, no SDK, spawned via `process.execPath` + `ELECTRON_RUN_AS_NODE=1` (compiled to `dist/main/src/main/features/memory/mcp-server/server.js`). Tools (`mem_*`, engram core): `mem_save`, `mem_search`, `mem_context`, `mem_session_summary`, `mem_get_observation`, `mem_save_prompt`, `mem_current_project`. `MemoryMcpInjector.serverConfig()` builds its `McpServerConfig`; `buildMemoryFeature()` exposes `memoryMcpServer` + `memoryMcpInjector`.

**Permission for `devia-memory` IS written to agent config** (same as kanban): for Claude it rides the runner's `--mcp-config` and is granted via `grantClaudeMcpAccess` in `.claude/settings.local.json`; for non-Claude agents `RunInstructionUseCase` calls `injectMemoryMcp` → `MemoryMcpInjector.inject()` → `McpSyncWriter` (native config). Both gated by `config.memory.enabled`.

**Blocking engram is the opposite — argv-only, NEVER a config-file write.** When `config.memory.blockEngram` and the agent is Claude, `RunInstructionUseCase` appends `--strict-mcp-config` so Claude loads ONLY Devia's `--mcp-config` servers and ignores engram's MCP (and any other user/project/plugin MCP). Known limitation: engram's Claude **plugin hook** (the SessionStart "ACTIVE PROTOCOL" banner) is NOT suppressed by `--strict-mcp-config` (only `--bare` would, and that breaks CLAUDE.md/skills — do not use it); the 19 `mem_*` engram tools are gone, only the banner text remains. Other agents have **no per-invocation MCP flag** (gemini/opencode/cursor/copilot/codex) so blocking can't be enforced for them — the Settings UI warns the user. Full agent-by-agent analysis: `docs/memory/01-mcp-block-mechanism.md`. **Enterprise carve-out (T-88):** under an enterprise-managed Claude MCP config, Claude **forbids BOTH** `--strict-mcp-config` (`You cannot use --strict-mcp-config when an enterprise MCP config is present`) AND `--mcp-config` (`You cannot dynamically configure MCP servers when an enterprise MCP config is present`) — either aborts the run before it starts. `enterpriseMcpConfigPresent()` (`claude-runner/infrastructure/enterprise-mcp-detector.ts`) probes TWO mechanisms, exclusive-control first: (1) the standalone **`managed-mcp.json`** (Claude's current "exclusive control" file — its mere presence as a valid JSON object carrying an `mcpServers` key activates the policy, EVEN when `mcpServers` is empty, which means "MCP disabled entirely" but the policy is still active); (2) the legacy **non-empty `mcpServers` embedded in `managed-settings.json`**. OS paths differ per file — `managed-mcp.json` lives at `/Library/Application Support/ClaudeCode/` (macOS), `/etc/claude-code/` (Linux/WSL), `C:\Program Files\ClaudeCode\` (Windows — **`Program Files`, NOT `ProgramData`**), while `managed-settings.json` on Windows is under `%PROGRAMDATA%`. When present, `RunInstructionUseCase` passes **neither** MCP flag (no `--mcp-config`, no `--strict-mcp-config`) so the run starts under the org's MCP policy — Devia's own servers (`devia-kanban`, `devia-memory`) are **not** injected for that run (adding them is an org/admin action in the enterprise managed config). Surfaced as a status notice. `DEVIA_ASSUME_ENTERPRISE_MCP=1`/`0` overrides detection. A claude.matchers rule classifies both abort messages with an actionable hint as a safety net.

**System prompt** — `infrastructure/memory-protocol.ts` is appended to the composed system prompt (as an extra pack body) only when `config.memory.enabled`, telling the agent the `mem_*` tools exist and when to use them.

**engram detection + import** — `DetectEngramUseCase` checks for the `engram` binary on PATH and `${ENGRAM_DATA_DIR:-~/.engram}/engram.db`. `ImportEngramUseCase` runs `engram export <tmp.json>` (needs the binary), maps observations into the **personal** store preserving the original `project` tag, skips soft-deleted + already-imported (by `syncId`), and marks `config.memory.engramImported`. Contract: `docs/memory/02-engram-import-contract.md`.

**Startup warning flow** — engram is detected during the splash scan (alongside agent detection) into `AppStateService.engramInstalled`. After the splash closes (`appReady`), `AppComponent` shows a one-per-launch **warning toast** (`ToastService`) when `engramInstalled && config.memory.enabled && !config.memory.blockEngram` — i.e. engram is active and unblocked, so its tools bloat every run. Clicking the toast opens Settings on the **Memory** section (`openSettings('memory')` → `MAT_DIALOG_DATA.section`), where the user blocks engram, toggles memory, and imports/re-imports. There is no first-launch modal (the earlier `EngramImportModalComponent` was removed in favour of the toast + Settings flow). `engramErrorKey` (import-error → i18n key) lives in `modals/engram-error-key.ts`. The Settings modal is the master-detail `ds-modal-shell`; Memory is a nav section + `@case ('memory')`.

**IPC channels** (in `IPC`): `memory:detect-engram`, `memory:import-engram`, `memory:search`, `memory:list`, `memory:list-sessions`, `memory:set-pinned`, `memory:forget`, `memory:clear` — bridge namespace `devia.memory.*`, wrappers on `ElectronApiService` (`detectEngram`/`importEngram`/`searchMemory`/`listMemory`/`listMemorySessions`/`setMemoryPinned`/`forgetMemory`/`clearMemory`). **The Settings panel lists OBSERVATIONS *and* SESSION summaries:** a project's `memory.json` is usually dominated by auto-captured run summaries (`sessions[]`) with few/no `observations[]`, so `memory:list-sessions` (→ `MemoryUseCase.context`, newest-first, capped at 10) surfaces those as the visible "Historial de sesiones" — otherwise the panel reads empty even when the file has content. Engram detect/import result types live in `src/shared/domain/memory.ts` so the bridge can reference them. **Cross-process cache invalidation (gotcha):** the `devia-memory` MCP server runs out-of-process and writes the same JSON files behind `MemoryStore`; the main-process store keeps an in-memory cache that the system-prompt recall path warms at run start, so every read/mutation IPC handler in `memory.ipc.ts` calls `store.invalidate(scope, projectPath)` first — otherwise the Settings → Memoria panel serves a pre-run snapshot and the agent's `mem_save` observations never appear. **Mutations are lost-update-safe at the store level:** every `MemoryStore` read-modify-write starts from disk (`loadFresh`, NEVER the cache — the cache is a read optimisation only, refreshed on `save()`), because the in-process passive-capture sinks (`saveMemoryPrompt`/`saveMemorySummary` at run end) used to write a doc cached at run start and silently dropped every observation the MCP server had saved mid-run. Related guard in `upsertSession`: the run-end auto-summary never replaces an agent-authored (non-auto) `mem_session_summary` for the same sessionId — only `endedAt`/`agentId` refresh — and a manual summary that upgrades an auto record clears the stale `auto` flag so the NEXT run-end capture can't clobber it either. The panel itself defaults to the **active project** scope (`AppStateService.selectedProject()` → `scope:'project'`, label "Memoria del proyecto: X") with a Proyecto/Personal toggle, falling back to personal when no project is selected.

---

## Cross-agent session handoff (S-2)

Continuing a session with a DIFFERENT CLI agent hands the context over automatically. Everything is desktop-only and rides existing infrastructure.

**Session identity (F0/F1).** `PersistedSession` carries `agentId` (CLI id) + `agentSessionId` (native conversation id), stamped by `SaveChatUseCase` from the transcript via `extractSessionIdentity()` (shared/domain/session.ts) and tolerated as absent by the parser. `SwitchSessionUseCase` and `AdoptSessionUseCase` restore the registry's native pointer (`agentSessionId`/`agentSessionAgentId`) from those fields (fallback: re-derive from messages); no identity → null pointer → fresh native session + memory pre-injection. `SessionMeta.agentId` drives the sidebar **agent badge** (warning tint when ≠ active agent). Devia memory records also stamp `agentId` on observations/sessions/prompts — the in-process sinks pass `def.id`; the out-of-process `devia-memory` MCP server gets it via the per-run env `DEVIA_ACTIVE_AGENT_ID`.

**Busy-session guards (F0.3/F0.4).** Renderer: `AppStateService.canSwitchSession()` blocks switching/deleting while the destination pane runs (toast + dimmed items). Main (authoritative — covers Telegram/queue races): `SwitchSessionUseCase`/`AdoptSessionUseCase` throw `SESSION_BUSY` (run active) and `SESSION_QUEUE_PENDING` (parked items would dispatch into the newly chosen session; queue consulted via the `QueueInspector` port in `src/main/shared/ports/`). `DeleteSessionUseCase` throws `SESSION_BUSY` only for the ACTIVE session. Codes are untranslated; the renderer maps them to i18n toasts.

**Handoff flow (F2/F3).** In `RunInstructionUseCase`, when `record.agentSessionAgentId` exists, differs from `def.id`, and the active session has messages: (1) `buildHandoffBrief()` (pure, shared/domain/handoff.ts — goal + touched files + verbatim 4-turn tail, 6000-char cap trimming tail first) is injected directly into THIS run's system prompt (never via memory recall — the first turn must be guaranteed); (2) the brief is recorded in memory as a `kind: 'handoff'` session entry — NOT `auto` (handoffs must enter recall/search) and APPENDED standalone (`upsertSession` skips `kind:'handoff'` records so later run summaries never overwrite it); (3) the `onSessionHandoff` port emits the `session:handoff` event (payload `SessionHandoffEvent`) BEFORE `process:start`, and `AppStateService` persists a `ChatMessage` with `kind:'handoff'` + `handoff:{fromAgentId,toAgentId}` (summary in `text`, so persistence/rehydration are untouched) — rendered by `HandoffDividerComponent` as a centred separator card with a collapsible summary. Idempotent without flags: this run's `session_started` overwrites the owner and the mismatch clears itself. Best-effort: a handoff failure never aborts the run. The Settings agent switch fires an informative toast (`detectPendingHandoff()`, features/chat/chat-panel/utils/agent-handoff.util.ts) when open sessions belong to another agent.

**Session adoption in split (F5).** `AdoptSessionUseCase` + IPC `session:adopt` load a persisted session under an ADDITIONAL pane's identity (runKey) without touching the primary's record. Renderer routing in `sidebar.openSession`: mounted → focus that pane (+`sidebar.session_in_other_pane` toast; the `'primary'` sentinel in `paneFocusRequest` targets the primary pane); busy destination → blocked; primary focused → `switchSession`; additional pane focused → `sessionAdoptRequest` consumed by `ChatPanesContainerComponent.adoptIntoFocusedPane()`, which RE-KEYS the pane to the adopted session (invariant: runKey === sessionRef.sessionId). The S-2 v1 rule "adopted sessions always run on the base checkout" is **SUPERSEDED by the S-3 F2.2 recovery chain**: `session:adopt` returns `{ workdir, branch?, isolation: 'worktree' | 'recreated' | 'none' }` and the pane re-keys onto the EFFECTIVE workdir (`isolatedFor` derives again). The old pane's eagerly-created worktree is removed when it has no run. Sessions mounted in panes show a **"Panel" badge** in the sidebar; in split mode the focused pane's session item carries the same `--dv-acc` accent (inset box-shadow). **Data-loss guard:** `closePane` and adoption call `flushSave(key)` BEFORE `clearChat(key)` — otherwise the pending debounced save persists an empty transcript.

**LLM-enriched handoff (F2.3).** `execute()` is synchronous (the queue dispatcher reads its busy result inline), so the LLM summary is never awaited at run time. `HandoffSummariser` (`features/context-compression/application/handoff-summariser.ts`) precomputes it in the BACKGROUND the moment a handoff becomes foreseeable — agent switch with foreign-owned primary sessions (`SelectAgentUseCase.onSelected` → composition-root sweep of registry records; pane runKeys are skipped, their adopt flow prepares them) or switching/adopting a foreign-owned session (`prepareHandoff` dep on Switch/AdoptSession). It runs `compress()` (headKeep 0 / tailKeep 4, one pass) with `selectAuxiliaryClient(cfg.agentId)` — same gating as E-DSK-09; with no configured client it never calls. The handoff step consumes the cache synchronously (`handoffSummary` dep; TTL 10 min, one-shot): hit → a "Resumen de la sesión" section between the touched files and the verbatim tail (`HandoffBriefOptions.summaryBody`); miss → deterministic brief, byte-identical to F2.2. Zero added run latency by construction.

**Premium layer (F3.4).** `RunInstructionUseCase.execute()` accepts `agentIdOverride` (threaded through `sendInstruction` runOpts, `submitInstruction`, and persisted on `QueueItem` like `origin`): the run executes under THAT agent — resuming its still-owned native session — instead of `cfg.agentId`; an unknown/non-CLI override rejects as a normal run error. Override runs SKIP passive memory capture (the internal prompt is not a user prompt, and the auto run-summary would upsert over the rich summary). The F3.3 toast gains an action button (`Toast.action`, rendered by `ToastsComponent`) — "Pedir resumen a {agente anterior}", offered only when `canRequestHandoffSummary()` (detected + selectable + authStatus ok) — which sends `buildHandoffRequestPrompt()` (orders a `mem_session_summary` with goal/state/decisions/next-step/files) on the focused session with `agentIdOverride` = previous agent and displayText "Generando resumen de traspaso…". The handoff step then PREFERS that rich summary when fresh (`recentHandoffSummary` dep → `MemoryUseCase.recentSessionSummary`, < 15 min, store cache invalidated first because the MCP server writes out-of-process) over the F2.3 compressed body.

---

## Session import (multi-agent, S-20 — generalises S-18)

Lets a user who already used a CLI agent import their existing sessions into
Devia. Desktop-only, `src/main/features/session-import/`. Today covers **Claude
Code** and **OpenAI Codex**; adding an agent is one registry entry (reader +
parser).

- **Framework.** A `SessionTranscriptReader` (`agentId` / `available` /
  `listTranscripts` → `SessionTranscriptRef{nativeId,filePath}` / `read`) plus a
  pure `TranscriptParser` (`parse(text) → ParsedTranscript`) make up an
  `ImportSource`. `index.ts` builds the registry (`FsClaudeProjectsReader` +
  `claudeParser`, `FsCodexSessionsReader` + `codexParser`); the generic
  `ScanSessionsUseCase` / `ImportSessionsUseCase` iterate it. `ParsedTranscript`
  (`src/shared/domain/agent-transcript.ts`) carries `agentId`, `agentSessionId`,
  `cwd`, `messages`, timestamps, `title?`, and **`resumable`** (native resume vs
  replay). Readers reuse the S-18 guards: `lstat` anti-symlink, 64 MiB cap.
- **Why it works at all.** A session's project is taken from the transcript's
  own absolute `cwd` (never a lossy directory name), and only sessions whose
  `cwd` is contained in `workspaceRoot` are offered (v1 scope). Scan groups by
  agent → workspace-relative project; import persists through `SessionStore.save`
  (idempotent by session id unless `force`, validates `cwd ↔ projectPath`, never
  touches the registry's active session).
- **Native resume is the headline.** The imported session reuses the agent's
  **own native conversation id** as the Devia session id, stamped `agentId` +
  `agentSessionId=<id>`. For a `resumable` agent, continuing it issues the
  native resume against the real transcript (via `SwitchSessionUseCase` /
  `AdoptSessionUseCase` restoring the native pointer), so the agent regains the
  FULL prior context — not just the rendered messages. Claude: `--resume <uuid>`
  (file id IS the uuid; `projectKey()` is byte-identical to Claude's lossy
  `<encoded-cwd>` dir naming, so the importer never reverses it). **Codex:**
  `exec resume <uuid>` where the uuid is the rollout id — identical to the
  `rollout-<ts>-<uuid>.jsonl` filename uuid AND `session_meta.payload.id`, the
  exact handle `codex exec resume` accepts. Replay-only agents (future Gemini /
  OpenCode) keep the same stamp so the runner re-seeds the transcript on the
  next turn.
- **Parsers** (pure, `src/shared/domain/`). `claude-transcript.ts` parses a `.jsonl`,
  aggregating one whole agentic turn (assistant text → tool_use → tool_result →
  …) into a single assistant message via the `PersistedAgentEvent` log +
  `rebuildFromEvents`, folding tool_result (which arrive on Claude *user* lines)
  into the in-flight turn and **excluding sidechains** (`isSidechain:true` /
  `subagents/`). `codex-transcript.ts` reads the rollout: line 1 `session_meta`
  (id + cwd + timestamp), then `response_item` records — `message`
  (input_text/output_text), `function_call` / `function_call_output` (tool
  call + result), encrypted `reasoning` skipped; the synthetic AGENTS.md +
  `<environment_context>` blocks codex prepends to the first user message are
  dropped. The whole turn aggregates into one assistant message, same as Claude.
  `grok-transcript.ts` (S-21 T-228) maps a grok-dev session materialised from
  its SQLite store: `fs-grok-sessions-reader.ts` opens `~/.grok/grok.db`
  **read-only via the built-in `node:sqlite`** (`GROK_HOME` aware; loaded lazily
  + guarded so the feature degrades to absent where `node:sqlite` is unavailable
  — no native dependency added), joins `sessions` + ordered `messages`, and
  serialises the aggregate to JSON; the pure parser folds the AI-SDK
  `ModelMessage` rows (user/assistant/tool parts) into one aggregated assistant
  turn. grok resumes natively (`grok --session <id>`) → `resumable: true`. A grok
  `SessionTranscriptRef` carries the SESSION ID in `filePath` (one db, N sessions).
- **IPC.** `session-import:scan` / `session-import:run`
  (`scanSessionImport` / `runSessionImport` on the bridge + `ElectronApiService`).
- **UI.** `SessionImportModalComponent` (wizard, grouped by **agent → project**,
  with a **"native resume" vs "replay"** badge per session) is reachable from
  Settings → Execution (the import affordance shows under each agent that has an
  importer) and from a **one-time first-run toast** (`AppComponent`, gated by the
  `devia.sessionImportPrompted` localStorage flag + at least one mappable
  session). i18n namespace `modals.session_import` + `toasts.session_import_*`.
- **Follow-up (S-20 backlog).** Gemini / OpenCode (replay) and Cursor / Copilot
  (under investigation) are not covered yet — each needs its own reader + parser
  added to the registry.

## Language rules

- **AI-targeted files** (this file, `.claude/` content, sub-agent prompts, code comments, JSDoc): **English**.
- **Human-targeted files** (README.md, UI strings, error messages, release notes): **Spanish**.
- **Always reply to the user in Spanish.**

---

## Shell conventions

- **Never prefix commands with `cd <project-root> &&`** — the shell working directory is already set to the project root automatically. Write commands directly: `npx tsc --noEmit`, `npx vitest run`, `git status`, etc.
