# Outbox (files emitted by the agent)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Archives files the agent drops into `outbox/` and, when a relay is connected, forwards them to the chat.

## Does

- `flush(projectPath, check?)` reads `<effective cwd>/outbox/` (the session worktree for an isolated pane, not `workspaceRoot/<project>`) and runs BEFORE `onProcessEnd`, in both `onDone` and `onError`; each REGULAR file is moved to `~/.devia-app/outbox-archive/`.
- When the run `canSendFiles`, each file is validated by the run's `RunFileGate` at its ORIGINAL path (inside the send roots) before it moves; admitted files are published as `file` events pointing at the ARCHIVED copy, refused ones (and symlinks, archived but never sent) as `file_rejected` (name + reason only). The admitted identity (`dev`/`ino`) survives the rename; a cross-device copy+unlink is re-bound by `rebindArchivedRunFile` (single-link regular file of the validated size, else `file_rejected` with reason `changed`).
- Without `canSendFiles` nothing is published; the renderer's `outbox:file` still fires AFTER `process:end`, routed by session identity, and the thread shows an outbox card.
- Counts toward the per-run limit `UI_LIMITS.sendFilesPerRun` = 10 together with `devia_send_file`.

## Does NOT

- Does NOT add `outbox/` to the project's `.gitignore` (the user should).
- Does NOT send folders or symlinks.
- Does NOT work in plan mode for agents without `devia_send_file` (plan cannot write files).
- Does NOT delete the archive automatically: no retention sweep exists for `outbox-archive/` (searched the feature and `src/main`); the only `unlink` is the cross-device copy fallback.

## Entry points

- `src/main/features/outbox/index.ts:buildOutboxFeature` — flush and archive
- `src/main/shared/outbound-file-gate.ts` — per-run revalidation
- `src/main/shared/outbound-file-guard.ts:checkOutboundFile` — roots/denylist guard
- `src/shared/domain/outbound-file-policy.ts` — limits and `SECRET_PATH_PATTERNS`

## IPC / MCP surface

- `outbox:file` (main → renderer).

## Persistence

`~/.devia-app/outbox-archive/`.

## Config

`remoteControl.allowFileSend`, `remoteControl.mirrorDesktop`.

## Gotchas

- The archive rename happens first so the agent cannot swap the file after validation; identity is re-checked at upload ([telegram-controller.md](telegram-controller.md)).

## Tests

`src/main/features/outbox/**/*.test.ts`, `src/main/shared/outbound-file-gate.test.ts`.

## Related

[telegram-controller.md](telegram-controller.md), [ui-tools.md](ui-tools.md), [security.md](security.md)
