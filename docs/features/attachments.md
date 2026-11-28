# Attachments

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Attach files of any type to an instruction (drop, paste, paperclip picker, or from Telegram) and tell the agent how to read them.

## Does

- `FsAttachmentEnricher` (`src/main/features/attachments/index.ts`) saves each attachment under `<deviaDir>/attachments/` (unicode-safe name, extension kept) and appends a per-kind note to the prompt: `buildAttachmentInstruction` in `src/shared/domain/attachment.ts` (shared with Telegram) labels by `attachmentKind` (image / pdf / text / video / audio / archive / binary) and, for kinds the Read tool cannot open, hints to inspect them with Bash.
- Caps enforced in BOTH processes: `MAX_ATTACHMENT_BYTES` 50 MB per file and `MAX_ATTACHMENTS_TOTAL_BYTES` 200 MB per send. The renderer refuses before copying bytes over IPC (toast); `saveAll` re-checks the whole batch before writing anything.
- Images keep an object-URL thumbnail; other files render as icon + size chips (`previewUrl: null`). Renderer service: `src/renderer/app/features/chat/chat-panel/services/pending-attachments.service.ts`; bar: `.../components/attachments-bar/`.
- When a run carries attachments in a confined mode, `<deviaDir>/attachments` is appended to `extraAllowedDirs` and `harness.readDirs` so the agent can `Read` them without a permission prompt (headless Claude cannot answer one).

## Does NOT

- Does NOT upload attachments anywhere: files stay local (except Telegram-originated ones, which are downloaded from Telegram first).
- Does NOT convert files (no OCR, no transcoding); the agent must be able to read the format.
- The attachments dir is never a root for `devia_send_file`.
- Does NOT expose IPC channels of its own: attachments ride on the instruction payload.

## Entry points

- `src/main/features/attachments/index.ts:buildAttachmentsFeature` — enricher
- `src/shared/domain/attachment.ts:buildAttachmentInstruction` — prompt note and caps
- `src/renderer/app/features/chat/chat-panel/services/pending-attachments.service.ts` — pending list

## IPC / MCP surface

- None (carried by `instruction:send`).

## Persistence

`~/.devia-app/attachments/`.

## Config

None.

## Gotchas

- Runs without attachments keep an identical argv (the extra dir is only added when `saved.length > 0`).
- Under `apply`, the whole-workspace `--add-dir` plus this dir widens what the agent may read/write; see [run-modes.md](run-modes.md).

## Tests

`src/main/features/attachments/attachments.test.ts`, `src/main/features/telegram-controller/application/attachment-note.test.ts`, and renderer specs for the pending-attachments service.

## Related

[chat-ui.md](chat-ui.md), [telegram-controller.md](telegram-controller.md), [outbox.md](outbox.md)
