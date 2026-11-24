# Sessions (chat history)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Persists each project's chat history on disk, with a native-agent identity per session, and lets the user switch, adopt, delete and list sessions.

## Does

- `FsSessionStore` (`src/main/features/sessions/infrastructure/fs-session-store.ts`) writes `~/.devia-app/sessions/<project>/session-<uuid>.json`; a per-project session index lives under `~/.devia-app/projects/<key>/`.
- Every read/write goes through `parsePersistedSession()` (`src/shared/domain/session.ts`), which tolerates missing optional fields.
- `PersistedSession` carries: messages, `agentId` + `agentSessionId` (native conversation id, stamped by `SaveChatUseCase` from the transcript with `extractSessionIdentity()`), `runMode`, `stats`, `workdir` + `worktreeBranch` (isolated panes), title.
- Use cases: `LoadChatsUseCase`, `SaveChatUseCase` (`chats:save`, and `chats:save-as` for a split pane under its own `sessionId`), `ListSessionsUseCase`, `SwitchSessionUseCase`, `AdoptSessionUseCase` (`session:adopt`, loads a session under an additional pane's identity), `DeleteSessionUseCase`, `LoadActiveStatsUseCase`, `AggregateStatsUseCase`.
- Busy guards in main (authoritative, also for Telegram/queue races): `SwitchSession`/`AdoptSession` throw `SESSION_BUSY` (a run is active) and `SESSION_QUEUE_PENDING` (parked items would dispatch into the new session); `DeleteSession` throws `SESSION_BUSY` only for the ACTIVE session. Codes are untranslated; the renderer maps them to i18n toasts.
- Deleting a session that carries `worktreeBranch` also tears down its worktree and branch (best effort, after the history delete).
- Sidebar shows an agent badge per session (`SessionMeta.agentId`, warning tint when it differs from the active agent) and a "Panel" badge for sessions mounted in a split pane.

## Does NOT

- Does NOT sync sessions between machines or to a server.
- Does NOT list sessions of CLIs that Devia did not run, unless imported ([session-import.md](session-import.md)).
- Does NOT keep the chat message thread of a deleted session; there is no undo.
- A session running as a split pane (`registry.isRunning(sessionId)`) refuses deletion.

## Entry points

- `src/main/features/sessions/index.ts:buildSessionsFeature` — wiring
- `src/main/features/sessions/application/save-chat.use-case.ts:SaveChatUseCase` — persist
- `src/main/features/sessions/application/switch-session.use-case.ts:SwitchSessionUseCase` — switch
- `src/main/features/sessions/application/adopt-session.use-case.ts:AdoptSessionUseCase` — adopt into a pane
- `src/main/features/sessions/application/delete-session.use-case.ts:DeleteSessionUseCase` — delete
- `src/main/features/sessions/infrastructure/fs-session-store.ts:FsSessionStore` — disk store
- `src/shared/domain/session.ts:parsePersistedSession` — boundary parser
- `src/shared/domain/chat.ts` — `ChatMessage`, `ContentBlock`, `ToolCallRecord`

## IPC / MCP surface

- `chats:loadAll`, `chats:save`, `chats:save-as`, `sessions:list`, `sessions:active-stats`, `stats:aggregate`, `session:switch`, `session:adopt`, `session:delete`, `session:reset`, `session:handoff`.

## Persistence

`~/.devia-app/sessions/<project>/session-<uuid>.json`; `~/.devia-app/projects/<key>/` index.

## Config

None specific.

## Gotchas

- Persistence for an additional pane is saved under the REAL base project with its own `sessionId` (not a synthetic folder), so `listSessions(base)` lists it and it survives restarts.
- `closePane` and adoption call `flushSave(key)` BEFORE `clearChat(key)`, else a pending debounced save persists an empty transcript.
- Rebuild of messages after load uses `PersistedAgentEvent`; usage fields must be added there to survive reload ([session-stats.md](session-stats.md)).

## Tests

- `src/main/features/sessions/**/*.test.ts`, `src/shared/domain/session.test.ts`.

## Related

- [session-handoff.md](session-handoff.md), [session-import.md](session-import.md), [split-view.md](split-view.md), [session-stats.md](session-stats.md), [run-modes.md](run-modes.md)
