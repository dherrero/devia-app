# Telegram remote control

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

An in-process Telegram bot that drives Devia runs from a phone and mirrors them in the app, with file relay back to the chat. Works only while Devia is open.

## Does

- Long-poll bot (`TelegramPoller`, `src/main/features/telegram-controller/infrastructure/telegram-poller.ts`) with a client-side timeout (`longPollSec` default 30, body timeout +5 s) and `wake()`; the feature wires `powerMonitor('resume') → wake()` and holds a `powerSaveBlocker('prevent-app-suspension')` only while connected, so a dead socket reconnects at once after sleep.
- `CommandRouter` (`application/command-router.ts`) implements `/projects`, `/use <path>`, `/status` (active project, run state, agent, mode, git branch/working-tree state, the session's context-usage % and accumulated cost from the S-7 `SessionStats` rollup), `/stop [project]`, `/clean [project]`, `/mode plan|apply|yolo`, `/agent`, `/subagents`, `/killsub <id|all>` (S-56 workers of other agents), `/sync`, `/exec <cmd>` and `!<cmd>` (gated by `remoteControl.allowShell`), `/help`, `/start`. Free text becomes an instruction on the active project through the `RunGateway` (`src/main/shared/run-gateway.ts`); a remote run carries `origin: 'remote'`, also persisted on queued items.
- S-56 (see [cross-agent.md](cross-agent.md)): when a REMOTE plan run calls `devia_assign_agents`, the router shows the question as plain Spanish text in the run's chat and keeps it pending per project; the next messages are parsed as the answer (`1. b  2. c`), several messages may complete it, only the unreadable lines are asked again, `saltar` keeps every role with the main agent, and a pending question dies with its run. A worker that ends gets one line (`A · pi · desarrollo · T-1: DONE`); nothing is sent while it works. `/stop` and `/clean` also cancel the project's workers.
- `/clean` stops the in-flight run first (`ResetSessionUseCase` → `registry.stopProject`), resets the session, clears the visible thread (event `session:reset` → `AppStateService.resetSessionLocal`) and drops the pending queue.
- Inbound attachments (photo, document, video, audio) are downloaded, saved through `AttachmentEnricher` and appended to the caption for the agent to Read; album without caption gets a prompt to resend ([attachments.md](attachments.md)).
- Optional desktop → chat mirror (`remoteControl.mirrorDesktop`, default off): user prompt (`👤`) and agent reply labelled `*[project]*`; Telegram → desktop is always mirrored in the app.
- UI tools over Telegram: the run is `origin: 'remote'`, so only non-interactive tools survive (`devia_todo`, `devia_notify`, `devia_skill`, plus `devia_send_file` when `canSendFiles`); the five decision tools are withheld and the agent learns the plain-text equivalent from `infrastructure/ui-tools-protocol.ts` and `remote-protocol.ts`. A runtime safety net auto-answers an agent's OWN built-in picker with a canned "you're on Telegram, re-ask as text" result instead of waiting for the 5-minute kill. ACP permission requests are left untouched.
- File output (S-32): `RunForwarder` accumulates the run's `file` events (deduped by path) and, after `finish()`, sends the text reply first (with `📎 N archivo(s) a continuación`) then the files via `TelegramClient.sendFile` / `sendMediaGroup` (multipart, one 429 retry honouring `retry_after` ≤ 30 s); `planFileBatches` orders photo+video albums, document albums, audio albums, max `MAX_MEDIA_GROUP` 10, each item with its own caption; an album that fails with 400 is retried item by item; a partly failed album rejects with `PartialUploadError`. Files are read one at a time by `readOutboundFile`: `open(O_RDONLY | O_NOFOLLOW)`, `fstat`, regular file with `nlink === 1`, same `dev`/`ino` as the admitted identity, exactly the validated `size` (≤ `MAX_UPLOAD_BYTES`), and only that many bytes are read from the handle. Refusals surface as `changed` / `hardlink` / `not-a-file` / `too-large` / `symlink` in one trailing `⚠️ No pude enviar: …` message.
- A user-stopped run (`end.error === 'stopped'` or `end.cancelReason === 'user'`) sends no files: `⏹️ *Detenido*` and one `⏹️ Ejecución detenida: no envié N archivo(s)` message, each pending file audited `failed:stopped`. Every upload outcome is audited (`delivered` / `failed:<reason>`, name and size only).
- A per-project promise tail makes the next run's reply wait for the previous run's uploads. Limits live in `src/shared/domain/outbound-file-policy.ts` (`MAX_UPLOAD_BYTES` 50 MB, `MAX_PHOTO_BYTES` 10 MB, `MAX_CAPTION_CHARS` 1024, `MAX_MEDIA_GROUP` 10).
- Security: only the configured `chatId` is served (allowlist of one; older messages ignored); the bot token is sealed at rest with Electron `safeStorage` (`src/main/shared/secret-vault.ts`, AES-256-GCM fallback without a keychain) and redacted from the config view; shell passthrough off by default.

## Does NOT

- Does NOT run in the background: closing Devia stops the bot.
- Does NOT offer interactive cards, plan approval, review or confirmations remotely (plain text, numbered options, answer in the next message).
- Does NOT support platforms other than Telegram (the `remoteControl` namespace is shaped to allow more).
- Does NOT serve more than one chat or user.
- Does NOT send files outside `workspaceRoot` (plus the run's live worktree), never secrets (code-constant denylist), never Devia's data dir, never hard links; uploads are not retried beyond the single 429 retry.
- Does NOT send a user-stopped run's files, nor auto-approve ACP permission requests on a remote run.
- A desktop mirror with a disconnected bot rejects `pushFile(s)` with `not-connected` (audited `failed:not-connected`).

## Entry points

- `src/main/features/telegram-controller/index.ts:buildTelegramControllerFeature` — wiring, power hooks
- `src/main/features/telegram-controller/application/telegram-controller.ts` — controller
- `src/main/features/telegram-controller/application/command-router.ts:CommandRouter` — commands
- `src/main/features/telegram-controller/application/commands.ts` — command menu
- `src/main/features/telegram-controller/application/stream-text.ts` — reply chunking
- `src/main/features/telegram-controller/application/attachment-note.ts` — attachment note
- `src/main/features/telegram-controller/infrastructure/telegram-client.ts` — Bot API client, `sendFile`, `sendMediaGroup`
- `src/main/features/telegram-controller/infrastructure/telegram-poller.ts:TelegramPoller`
- `src/main/features/telegram-controller/infrastructure/shell-runner.ts` — gated shell
- `src/main/features/telegram-controller/ipc/telegram.ipc.ts`
- `src/main/shared/run-gateway.ts` — run submission and event stream
- `src/shared/domain/remote-control.ts` — status types
- `src/shared/domain/outbound-file-policy.ts` — limits and denylist

## IPC / MCP surface

- `remoteControl:get-status`, `remoteControl:test`, `remoteControl:restart`, `remoteControl:status` (push).

## Persistence

`config.remoteControl` in `devia-app.config.json` (token sealed); audit log (`<userData>/audit.log`) for file outcomes; attachments under `~/.devia-app/attachments/`.

## Config

`remoteControl.telegram.{enabled, botToken, chatId}`, `remoteControl.allowShell` (default false), `remoteControl.mirrorDesktop` (default false), `remoteControl.allowFileSend` (default true, read per run).

## Gotchas

- Remote questions work by turns: the agent asks in text, ends the turn, the user replies in the next message of the same session.
- The desktop's `outbox:file` event fires AFTER `process:end`, routed by session identity; the thread card is labelled "For Telegram" and does not mean the upload happened.
- `devia_send_file` is an exfiltration channel: the layered defences (roots, deny roots, denylist, realpath, hard-link check, main revalidation, upload-time handle check) must never be relaxed ([security.md](security.md)).
- Telegram has no clickable UI, so `devia_notify` is MORE useful there than on desktop.

## Tests

`src/main/features/telegram-controller/**/*.test.ts` (router, poller, client, forwarder, shell runner).

## Related

[telegram-controller/user-guide.md](telegram-controller/user-guide.md), [ui-tools.md](ui-tools.md), [outbox.md](outbox.md), [attachments.md](attachments.md), [security.md](security.md), [queue.md](queue.md)
